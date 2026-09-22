"""
build_shorts.py
----------------
제주도 기반 판타지/B급 바이럴 쇼츠를 주제 한 줄로 완성 MP4까지 만드는 풀 파이프라인.

    주제 -> 스토리보드(6장면 대본·이미지프롬프트·SFX·BGM)
         -> 장면 이미지 6장 (Flux, 9:16)
         -> 장면별 TTS 음성 + 단어별 타이밍
         -> Ken Burns + 단어 자막 + SFX + BGM(-15dB) 합성
         -> out/<슬러그>/final.mp4

대본·이미지프롬프트 생성은 배포된 ai-image-platform API를 그대로 쓰고(로직 중복 없음),
영상 합성만 로컬에서 MoviePy/FFmpeg로 처리한다(서버리스에서 못 돌리는 작업이라).

사용 예시:
    python build_shorts.py --topic "한라산 백록담에서 물 떠먹었더니 돌하르방이 말을 걸었다"

    # 대본/이미지까지만 만들고 영상 합성은 건너뛰기(검토용)
    python build_shorts.py --topic "..." --skip-video

    # 이미 만든 스토리보드로 영상만 다시 뽑기
    python build_shorts.py --storyboard out/한라산-백록담/storyboard.json

환경변수는 .env.example 참고 (.env로 복사해서 사용).
"""

import argparse
import asyncio
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# 회사 프록시가 자체 서명 인증서로 TLS를 가로채기 때문에, 파이썬 기본 인증서 번들만
# 쓰면 API/TTS 호출이 전부 CERTIFICATE_VERIFY_FAILED로 막힌다. 검증을 끄는 대신
# 윈도우 인증서 저장소(회사 루트 CA가 이미 신뢰됨)를 쓰도록 바꾼다.
try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:  # 개인 네트워크 등 필요 없는 환경에서는 없어도 그만이다.
    pass

# 윈도우 기본 콘솔(cp949)은 em대시 같은 문자를 인코딩하지 못해 print에서 그대로
# 죽어버린다(실제로 합성 마지막 단계에서 크래시했다). 출력 때문에 작업이 날아가면
# 안 되니 표현 불가 문자는 대체하고 진행한다.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

SKILL_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SKILL_DIR.parents[2]  # .claude/skills/viral-shorts -> ai-image-platform
# 가변 폰트의 기본 굵기는 Thin(100)이다. 그대로 쓰면 머리카락 같은 글씨에 두꺼운
# 테두리만 두른 꼴이라 제목이 조잡해 보인다. Black(900)으로 고정한 본을 쓴다.
_FONT_DIR = PROJECT_ROOT / "public" / "fonts"
FONT_PATH = _FONT_DIR / "NotoSansKR-Black.ttf"
if not FONT_PATH.exists():  # 아직 안 받은 저장소에서도 돌아가게 물러설 자리를 둔다
    FONT_PATH = _FONT_DIR / "NotoSansKR-Variable.ttf"
SFX_DIR = SKILL_DIR / "assets" / "sfx"
BGM_DIR = SKILL_DIR / "assets" / "bgm"

DEFAULT_BASE_URL = "https://ai-image-platform-lilac.vercel.app"
DEFAULT_VOICE = "ko-KR-SunHiNeural"

VIDEO_WIDTH, VIDEO_HEIGHT = 1080, 1920
FPS = 30

# 자막은 하단 25%(쇼츠 제목/채널정보 자리) 위쪽에 둔다.
SUBTITLE_Y = int(VIDEO_HEIGHT * 0.62)
THUMBNAIL_COPY_Y = 110

# 제목은 첫 1.6초짜리 훅이라 이야기 분위기와 색이 어긋나면 그 자리에서 넘긴다.
# 그래서 스토리보드가 고른 bgmMood에 맞춰 색과 두께를 바꾼다. 반면 자막은 영상
# 내내 떠 있는 기능적 요소라, 분위기마다 색이 바뀌면 산만하고 읽기 피로해진다.
# 그래서 자막은 아래 SUBTITLE_COLOR로 고정한다.
SUBTITLE_COLOR = "#F5FF00"
TITLE_STYLES = {
    # 차갑고 서늘하게. 흰색이 가장 멀리서도 먼저 읽힌다.
    "mystery": {"color": "#FFFFFF", "stroke": 9, "shadow": 13, "size": 112},
    # 금색은 스케일과 무게감을 준다. 테두리를 두껍게 해 하늘 배경에서도 버틴다.
    "epic": {"color": "#FFD24D", "stroke": 13, "shadow": 12, "size": 116},
    # 형광 노랑은 가장 시끄럽고 가장 잘 읽힌다. 코믹한 이야기에 맞다.
    "playful": {"color": "#F5FF00", "stroke": 13, "shadow": 11, "size": 118},
    # 몽환은 테두리를 얇게 하고 그림자로 띄운다. 외곽선이 굵으면 분위기가 깨진다.
    "dreamy": {"color": "#FFEAF3", "stroke": 7, "shadow": 17, "size": 110},
}
DEFAULT_TITLE_STYLE = TITLE_STYLES["playful"]
# 좌우 15%는 좋아요/댓글 버튼 자리라 텍스트가 침범하지 않도록 폭을 제한한다.
TEXT_MAX_WIDTH = int(VIDEO_WIDTH * 0.7)
SUBTITLE_MAX_HEIGHT = 280
THUMBNAIL_COPY_MAX_HEIGHT = 430

# 나레이션을 통째로 한 번에 읽히므로 장면 사이에 무음을 따로 끼우지 않는다.
# 이 값은 마지막 장면에서 말이 끝나자마자 영상이 뚝 끊기지 않게 두는 꼬리 여유다.
SCENE_TAIL_PADDING = 0.08
# 쇼츠 나레이션은 일상 대화보다 조금 빨라야 넘기지 않는다.
NARRATION_RATE = "+12%"

# 한 번 호출에 한 가지 톤으로만 읽히기 때문에, 영상마다 같은 목소리·같은 높이로
# 나오면 여러 편을 이어 보는 사람에게 전부 같은 영상처럼 들린다. 이야기 분위기에
# 맞춰 높이와 속도를 바꿔 편마다 결이 달라지게 한다.
VOICE_STYLES = {
    "mystery": {"voice": DEFAULT_VOICE, "rate": "+8%", "pitch": "-12Hz"},
    "epic": {"voice": "ko-KR-InJoonNeural", "rate": "+10%", "pitch": "-8Hz"},
    "playful": {"voice": DEFAULT_VOICE, "rate": "+20%", "pitch": "+18Hz"},
    "dreamy": {"voice": DEFAULT_VOICE, "rate": "+6%", "pitch": "+6Hz"},
}
DEFAULT_VOICE_STYLE = {
    "voice": DEFAULT_VOICE,
    "rate": NARRATION_RATE,
    "pitch": "+0Hz",
}
# 장면 사이에는 쉼표만 넣는다. 마침표로 끊으면 TTS가 끝을 내려 읽어 단절감이 생긴다.
NARRATION_JOINER = ", "
KEN_BURNS_ZOOM = 1.12
BGM_GAIN = 10 ** (-15 / 20)  # 요구사항: BGM -15dB 감쇄
THUMBNAIL_COPY_SECONDS = 1.6


# --------------------------------------------------------------------------
# 설정
# --------------------------------------------------------------------------

def _parse_env_file(path: Path) -> dict:
    values: dict = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key:
            values[key] = value.strip().strip('"').strip("'")
    return values


class ConfigError(SystemExit):
    def __init__(self, message: str):
        super().__init__(f"설정 오류: {message}")


def load_config() -> dict:
    for key, value in _parse_env_file(SKILL_DIR / ".env").items():
        os.environ.setdefault(key, value)

    email = os.environ.get("AI_PLATFORM_EMAIL", "").strip()
    password = os.environ.get("AI_PLATFORM_PASSWORD", "")
    if not email or not password:
        raise ConfigError(
            f"{SKILL_DIR / '.env'} 에 AI_PLATFORM_EMAIL / AI_PLATFORM_PASSWORD를 채워주세요 "
            "(.env.example 참고, 초대받은 계정 로그인 정보)."
        )

    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    supabase_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not supabase_url or not supabase_key:
        project_env = _parse_env_file(PROJECT_ROOT / ".env.local")
        supabase_url = supabase_url or project_env.get("NEXT_PUBLIC_SUPABASE_URL", "")
        supabase_key = supabase_key or project_env.get(
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ""
        )
    if not supabase_url or not supabase_key:
        raise ConfigError(
            "Supabase URL/키를 찾을 수 없습니다. .env에 직접 넣거나 "
            "ai-image-platform/.env.local이 있는지 확인해주세요."
        )

    base_url = (
        os.environ.get("AI_PLATFORM_BASE_URL", "").strip() or DEFAULT_BASE_URL
    ).rstrip("/")

    return {
        "email": email,
        "password": password,
        "supabase_url": supabase_url.rstrip("/"),
        "supabase_key": supabase_key,
        "base_url": base_url,
    }


# --------------------------------------------------------------------------
# API 호출
# --------------------------------------------------------------------------

def _http_post(url: str, payload: dict, headers: dict, timeout: int = 180) -> bytes:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(raw).get("error", raw)
        except json.JSONDecodeError:
            message = raw
        raise RuntimeError(f"{url} 호출 실패 ({err.code}): {message}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"{url} 에 연결하지 못했습니다: {err.reason}") from err


def _http_post_json(url: str, payload: dict, headers: dict, timeout: int = 180) -> dict:
    return json.loads(_http_post(url, payload, headers, timeout).decode("utf-8"))


def sign_in(config: dict) -> str:
    result = _http_post_json(
        f"{config['supabase_url']}/auth/v1/token?grant_type=password",
        {"email": config["email"], "password": config["password"]},
        {"apikey": config["supabase_key"]},
        timeout=60,
    )
    token = result.get("access_token")
    if not token:
        raise RuntimeError(f"로그인에 실패했습니다: {result}")
    return token


def fetch_storyboard(config: dict, token: str, topic: str) -> dict:
    return _http_post_json(
        f"{config['base_url']}/api/shorts/storyboard",
        {"topic": topic},
        {"Authorization": f"Bearer {token}"},
    )


def generate_scene_image(config: dict, token: str, prompt: str) -> str:
    result = _http_post_json(
        f"{config['base_url']}/api/generate",
        # 스토리보드 단계에서 이미 캐릭터·구도 지시까지 담은 영문 프롬프트라 재보강하지 않는다.
        {"prompt": prompt, "format": "story", "count": 1, "enhance": False},
        {"Authorization": f"Bearer {token}"},
    )
    urls = result.get("imageUrls") or []
    if not urls:
        raise RuntimeError(f"이미지를 받지 못했습니다: {result}")
    return urls[0]


IMAGE_MAGIC_PREFIXES = (b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"GIF8")


def download_image(config: dict, token: str, url: str, dest: Path) -> Path:
    """이미지를 우리 서버의 다운로드 프록시를 통해 받아온다.

    Replicate CDN(replicate.delivery)을 로컬에서 직접 받으면, 회사망처럼 미분류
    도메인을 가로채는 프록시 환경에서 이미지 대신 차단 안내 HTML이 내려온다
    (실제로 이 스크립트 첫 실행에서 그렇게 실패했다). 배포 서버는 그 프록시
    밖에 있으므로 /api/download 가 대신 받아서 넘겨주면 어느 망에서든 동작한다.
    """
    proxied = (
        f"{config['base_url']}/api/download?url={urllib.parse.quote(url, safe='')}"
    )
    request = urllib.request.Request(
        proxied, headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = response.read()
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"이미지 다운로드 실패 ({err.code}): {raw}") from err

    if not payload.startswith(IMAGE_MAGIC_PREFIXES):
        raise RuntimeError(
            "내려받은 파일이 이미지가 아닙니다. 네트워크(프록시)가 응답을 가로챘을 수 "
            f"있습니다. 앞부분: {payload[:80]!r}"
        )

    dest.write_bytes(payload)
    return dest


# --------------------------------------------------------------------------
# TTS (edge-tts) — 단어별 타이밍까지 함께 받는다
# --------------------------------------------------------------------------

async def _synthesize(
    text: str, voice: str, dest: Path, rate: str, pitch: str
) -> list[dict]:
    import edge_tts

    communicate = edge_tts.Communicate(
        text, voice, rate=rate, pitch=pitch, boundary="WordBoundary"
    )
    words: list[dict] = []
    with open(dest, "wb") as handle:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                handle.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append(
                    {
                        "text": chunk["text"],
                        "start": chunk["offset"] / 1e7,
                        "duration": chunk["duration"] / 1e7,
                    }
                )
    return words


def synthesize_narration(
    text: str,
    voice: str,
    dest: Path,
    rate: str = NARRATION_RATE,
    pitch: str = "+0Hz",
) -> list[dict]:
    """나레이션을 mp3로 만들고 단어별 (시작초, 길이) 목록을 돌려준다."""
    return asyncio.run(_synthesize(text, voice, dest, rate, pitch))


def _ink(text: str) -> str:
    """공백과 이어붙임용 쉼표를 뺀, 실제로 읽히는 글자만 남긴다."""
    return re.sub(r"[\s,]", "", text)


def synthesize_all_narrations(
    narrations: list[str],
    dest: Path,
    style: dict | None = None,
) -> list[list[dict]]:
    """전체 나레이션을 한 번에 읽히고, 단어 타이밍으로 장면 경계를 되찾는다.

    줄마다 따로 합성하면 TTS가 매 줄을 완결된 문장으로 취급해 끝을 내려 읽고,
    클립마다 앞뒤 무음까지 붙어서 장면 사이가 뚝뚝 끊긴다. 한 번에 읽히면 억양이
    이어져 한 사람이 쭉 말하는 것처럼 들린다.
    """
    style = style or DEFAULT_VOICE_STYLE
    joined = NARRATION_JOINER.join(n.strip() for n in narrations)
    try:
        words = synthesize_narration(
            joined, style["voice"], dest, style["rate"], style["pitch"]
        )
    except Exception as err:  # 목소리 이름이 바뀌어도 영상은 나와야 한다
        fallback = DEFAULT_VOICE_STYLE["voice"]
        if style["voice"] == fallback:
            raise
        print(f"    ({style['voice']} 를 쓸 수 없어 {fallback} 로 대신합니다: {err})")
        words = synthesize_narration(
            joined, fallback, dest, style["rate"], style["pitch"]
        )

    # edge-tts가 단어를 어떻게 쪼개 돌려주든, 읽히는 글자 수를 세어 맞추면
    # 장면 경계가 어긋나지 않는다(토큰 개수로 맞추면 구두점 때문에 밀린다).
    targets = [len(_ink(n)) for n in narrations]
    per_scene: list[list[dict]] = [[] for _ in narrations]
    index = 0
    filled = 0
    for word in words:
        if index < len(narrations) - 1 and filled >= targets[index]:
            index += 1
            filled = 0
        per_scene[index].append(word)
        filled += len(_ink(word["text"]))

    empty = [i + 1 for i, chunk in enumerate(per_scene) if not chunk]
    if empty:
        raise RuntimeError(
            f"나레이션을 장면별로 나누지 못했습니다(빈 장면: {empty}). "
            "--regenerate 로 다시 시도해주세요."
        )
    return per_scene


# --------------------------------------------------------------------------
# 이미지 전처리
# --------------------------------------------------------------------------

def fit_to_frame(src: Path, dest: Path) -> Path:
    """생성 이미지를 1080x1920에 꽉 차게 잘라 맞춘다(비율 왜곡 없이)."""
    from PIL import Image

    image = Image.open(src).convert("RGB")
    target_ratio = VIDEO_WIDTH / VIDEO_HEIGHT
    src_ratio = image.width / image.height

    if src_ratio > target_ratio:
        new_width = int(image.height * target_ratio)
        left = (image.width - new_width) // 2
        image = image.crop((left, 0, left + new_width, image.height))
    else:
        new_height = int(image.width / target_ratio)
        top = (image.height - new_height) // 2
        image = image.crop((0, top, image.width, top + new_height))

    image.resize((VIDEO_WIDTH, VIDEO_HEIGHT), Image.LANCZOS).save(dest)
    return dest


# --------------------------------------------------------------------------
# 영상 합성
# --------------------------------------------------------------------------

# 자막/카피는 반드시 좌우 세이프존 안에 들어가야 한다. method="caption"에 폭을 주면
# 띄어쓰기가 없는 한글 문자열도 알아서 줄바꿈해주고, 그래도 세로로 길어지면 글자
# 크기를 줄여서 맞춘다(폭을 안 잡아주면 긴 문구가 화면 밖으로 잘려 나간다 — 실제로
# 테스트에서 상단 카피가 양쪽으로 잘리는 걸 확인하고 넣은 처리).
def _text_clip(
    text: str,
    font_size: int,
    stroke_width: int,
    max_height: int,
    min_font_size: int = 44,
    color: str = SUBTITLE_COLOR,
):
    from moviepy import TextClip

    size = font_size
    while True:
        clip = TextClip(
            font=str(FONT_PATH),
            text=text,
            font_size=size,
            color=color,
            stroke_color="black",
            stroke_width=stroke_width,
            method="caption",
            size=(TEXT_MAX_WIDTH, None),
            # caption 방식의 높이 계산은 위쪽 여백만 잡아주고 아래쪽은 잡아주지
            # 않는다. 실제로 재보면 한글 자막의 잉크가 이미지 맨 아래 픽셀까지
            # 닿아서(아래 여백 0px) 검은 테두리와 받침 아래가 깎여 나갔다.
            # 그래서 4-tuple로 아래 여백만 따로 키운다. stroke*6이면 어떤 단어든
            # 30px 이상 남는 것을 측정으로 확인했다.
            # 테두리가 얇은 스타일에서는 stroke*6이 너무 작아져 다시 아슬아슬해지므로
            # 바닥은 최소값을 둔다.
            margin=(
                stroke_width * 2,
                stroke_width * 2,
                stroke_width * 2,
                max(stroke_width * 6, 48),
            ),
        )
        if clip.h <= max_height or size <= min_font_size:
            return clip
        clip.close()
        size -= 8


def _ken_burns(clip, duration: float, mode: str):
    """느린 줌 인/아웃. 항상 배율 >= 1이라 프레임에 빈 곳이 생기지 않는다."""
    start, end = (
        (1.0, KEN_BURNS_ZOOM) if mode == "in" else (KEN_BURNS_ZOOM, 1.0)
    )

    def scale(t: float) -> float:
        progress = min(max(t / duration, 0.0), 1.0)
        return start + (end - start) * progress

    return clip.resized(scale).with_position(("center", "center"))


def build_scene_clip(
    scene: dict,
    image_path: Path,
    duration: float,
    thumbnail_copy: str = "",
    ken_burns: bool = True,
    mood: str = "playful",
):
    """장면 1개: Ken Burns 배경 + 단어별 자막 (+ 첫 장면이면 썸네일 카피)."""
    from moviepy import CompositeVideoClip, ImageClip

    still = ImageClip(str(image_path)).with_duration(duration)
    # Ken Burns는 매 프레임 리사이즈라 렌더 시간의 대부분을 차지한다. 자막·타이밍만
    # 빠르게 확인하고 싶을 때는 끌 수 있게 해둔다.
    background = (
        _ken_burns(still, duration, scene.get("kenBurns", "in"))
        if ken_burns
        else still.with_position(("center", "center"))
    )

    layers = [background]
    for word in scene.get("words", []):
        text = word["text"].strip()
        if not text:
            continue
        # 마지막 단어는 장면 끝까지 남겨 자막이 갑자기 사라지지 않게 한다.
        word_duration = max(word["duration"], 0.28)
        start = min(word["start"], max(duration - 0.05, 0.0))
        word_duration = min(word_duration, duration - start)
        if word_duration <= 0:
            continue
        layers.append(
            _text_clip(text, 96, 12, SUBTITLE_MAX_HEIGHT)
            .with_start(start)
            .with_duration(word_duration)
            .with_position(("center", SUBTITLE_Y))
        )

    if thumbnail_copy:
        style = TITLE_STYLES.get(mood, DEFAULT_TITLE_STYLE)
        shown = min(THUMBNAIL_COPY_SECONDS, duration)

        # 그림자를 한 겹 아래 깔고 그 위에 본 글씨를 얹는다. 배경이 밝은 하늘이든
        # 어두운 바다든 제목이 묻히지 않게 하는 가장 값싼 방법이고, 테두리만 두껍게
        # 키우는 것보다 글자 모양을 덜 망가뜨린다.
        layers.append(
            _text_clip(
                thumbnail_copy,
                style["size"],
                style["stroke"],
                THUMBNAIL_COPY_MAX_HEIGHT,
                color="black",
            )
            .with_start(0)
            .with_duration(shown)
            .with_opacity(0.5)
            .with_position(("center", THUMBNAIL_COPY_Y + style["shadow"]))
        )
        layers.append(
            _text_clip(
                thumbnail_copy,
                style["size"],
                style["stroke"],
                THUMBNAIL_COPY_MAX_HEIGHT,
                color=style["color"],
            )
            .with_start(0)
            .with_duration(shown)
            .with_position(("center", THUMBNAIL_COPY_Y))
        )

    return CompositeVideoClip(layers, size=(VIDEO_WIDTH, VIDEO_HEIGHT)).with_duration(
        duration
    )


def build_audio(
    scenes: list[dict],
    total_duration: float,
    bgm_mood: str,
    narration_path: Path,
):
    """나레이션 + 장면별 SFX + 루프 BGM(-15dB)을 한 트랙으로 섞는다."""
    from moviepy import AudioFileClip, CompositeAudioClip, afx

    # 나레이션은 통째로 한 트랙이다. 장면마다 잘라 붙이면 이어 읽힌 억양이
    # 이음매에서 다시 끊기므로 자르지 않는다.
    tracks = [AudioFileClip(str(narration_path)).with_start(0)]

    for scene in scenes:
        cue = scene.get("sfx", "none")
        if cue and cue != "none":
            sfx_path = SFX_DIR / f"{cue}.mp3"
            if sfx_path.exists():
                tracks.append(AudioFileClip(str(sfx_path)).with_start(scene["start"]))
            else:
                print(f"    (효과음 없음: {sfx_path.name} — 건너뜀)")

    bgm_path = BGM_DIR / f"{bgm_mood}.mp3"
    if bgm_path.exists():
        bgm = AudioFileClip(str(bgm_path)).with_effects(
            [afx.AudioLoop(duration=total_duration)]
        )
        tracks.append(bgm.with_volume_scaled(BGM_GAIN).with_start(0))
    else:
        print(f"    (BGM 없음: {bgm_path.name} — 건너뜀)")

    return CompositeAudioClip(tracks).with_duration(total_duration)


def build_video(
    storyboard: dict,
    scenes: list[dict],
    out_path: Path,
    narration_path: Path,
    ken_burns: bool = True,
) -> Path:
    from moviepy import concatenate_videoclips

    # 훅용 썸네일 카피는 첫 장면 안에서 합성한다. 완성된 영상 전체를 다시
    # CompositeVideoClip으로 감싸면 1.6초짜리 자막 하나 때문에 모든 프레임이 합성
    # 단계를 한 번 더 거치게 되어 렌더가 눈에 띄게 느려진다.
    copy_text = storyboard.get("thumbnailCopy", "").strip()
    mood = storyboard.get("bgmMood", "playful")

    clips = [
        build_scene_clip(
            scene,
            scene["image_path"],
            scene["duration"],
            thumbnail_copy=copy_text if index == 0 else "",
            ken_burns=ken_burns,
            mood=mood,
        )
        for index, scene in enumerate(scenes)
    ]
    video = concatenate_videoclips(clips, method="compose")

    video = video.with_audio(
        build_audio(
            scenes,
            video.duration,
            storyboard.get("bgmMood", "mystery"),
            narration_path,
        )
    )
    video.write_videofile(
        str(out_path),
        fps=FPS,
        codec="libx264",
        audio_codec="aac",
        # 세로 1080x1920은 프레임이 커서 medium으로 두면 30초 영상에도 10분 넘게
        # 걸린다. 화질 차이는 거의 없고 속도는 크게 줄어드는 veryfast를 쓴다.
        preset="veryfast",
        threads=os.cpu_count() or 4,
        logger=None,
    )
    return out_path


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def slugify(text: str, max_length: int = 30) -> str:
    slug = re.sub(r"[^\w가-힣-]+", "-", text.strip()).strip("-")
    return (slug or "shorts")[:max_length]


def format_timeline(scenes: list[dict]) -> str:
    lines = []
    for scene in scenes:
        stamp = f"[{int(scene['start']) // 60:02d}:{int(scene['start']) % 60:02d}]"
        cue = scene.get("sfx", "none")
        sfx_note = "효과음 없음" if cue == "none" else f"SFX: {cue}"
        lines.append(f"{stamp} 장면{scene['index']} · {sfx_note} · {scene['narration']}")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="주제 한 줄로 제주 판타지 B급 쇼츠 영상을 자동 제작합니다."
    )
    parser.add_argument("--topic", default=None, help="영상 주제 한 줄")
    parser.add_argument(
        "--storyboard",
        default=None,
        help="이미 만든 storyboard.json 경로 (대본 생성을 건너뛰고 재사용)",
    )
    parser.add_argument(
        "--project",
        default=None,
        help="웹 화면에서 내려받은 shorts-project.json 경로 "
        "(업로드한 이미지로 만든 시나리오를 그대로 영상으로 만든다)",
    )
    parser.add_argument("--out-dir", default="out", help="결과 저장 폴더 (기본: ./out)")
    parser.add_argument(
        "--voice",
        default=None,
        help="edge-tts 음성 이름 (기본: 이야기 분위기에 맞춰 자동 선택)",
    )
    parser.add_argument(
        "--skip-video",
        action="store_true",
        help="대본·이미지·음성까지만 만들고 영상 합성은 건너뛴다",
    )
    parser.add_argument(
        "--regenerate",
        action="store_true",
        help="이미 만들어둔 이미지·음성을 무시하고 전부 새로 생성한다(이미지 생성 비용 발생)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.topic and not args.storyboard and not args.project:
        sys.exit("오류: --topic, --storyboard, --project 중 하나는 필요합니다.")
    if not FONT_PATH.exists():
        sys.exit(f"오류: 자막용 한글 폰트를 찾을 수 없습니다 -> {FONT_PATH}")

    config = load_config()
    print("1) 로그인 중...")
    token = sign_in(config)

    if args.project:
        storyboard = json.loads(Path(args.project).read_text(encoding="utf-8"))
        print(f"2) 웹에서 만든 프로젝트 사용: {args.project}")
    elif args.storyboard:
        storyboard = json.loads(Path(args.storyboard).read_text(encoding="utf-8"))
        print(f"2) 기존 스토리보드 사용: {args.storyboard}")
    else:
        print("2) 스토리보드(6장면 대본·이미지프롬프트·SFX) 생성 중...")
        storyboard = fetch_storyboard(config, token, args.topic)

    work_dir = Path(args.out_dir) / slugify(
        args.topic or storyboard.get("thumbnailCopy", "shorts")
    )
    (work_dir / "images").mkdir(parents=True, exist_ok=True)
    (work_dir / "audio").mkdir(parents=True, exist_ok=True)
    (work_dir / "storyboard.json").write_text(
        json.dumps(storyboard, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"   썸네일 카피: {storyboard.get('thumbnailCopy')}")
    print(f"   BGM 분위기: {storyboard.get('bgmMood')}")

    # 이미지를 먼저 다 준비한다. 나레이션은 그다음에 통째로 한 번 읽힌다.
    prepared: list[dict] = []
    for raw_scene in storyboard["scenes"]:
        index = raw_scene["index"]
        raw_path = work_dir / "images" / f"scene_{index}_raw.webp"
        image_path = work_dir / "images" / f"scene_{index}.png"

        # 같은 폴더로 다시 돌리면 이미 만든 소재를 재사용한다. 이미지는 생성할 때마다
        # 실제로 비용이 나가므로, 자막·효과음만 손보려고 재실행할 때 또 낼 이유가 없다.
        if image_path.exists() and not args.regenerate:
            print(f"3-{index}) 장면 {index} 이미지 재사용")
        elif raw_scene.get("imageUrl"):
            # 웹에서 올린 이미지는 이미 있으니 받아오기만 하면 된다(생성 비용 없음).
            print(f"3-{index}) 장면 {index} 업로드 이미지 내려받는 중...")
            download_image(config, token, raw_scene["imageUrl"], raw_path)
            fit_to_frame(raw_path, image_path)
        else:
            print(f"3-{index}) 장면 {index} 이미지 생성 중...")
            download_image(
                config,
                token,
                generate_scene_image(config, token, raw_scene["imagePrompt"]),
                raw_path,
            )
            fit_to_frame(raw_path, image_path)

        prepared.append({**raw_scene, "image_path": image_path})

    narration_path = work_dir / "audio" / "narration.mp3"
    words_path = work_dir / "audio" / "narration.words.json"
    if narration_path.exists() and words_path.exists() and not args.regenerate:
        print("4) 나레이션 재사용")
        per_scene_words = json.loads(words_path.read_text(encoding="utf-8"))
    else:
        mood = storyboard.get("bgmMood", "playful")
        style = dict(VOICE_STYLES.get(mood, DEFAULT_VOICE_STYLE))
        if args.voice:
            style["voice"] = args.voice
        print(
            f"4) 나레이션 {len(prepared)}줄을 한 번에 합성하는 중... "
            f"({mood} 톤 · {style['voice']} · 속도 {style['rate']} · 높이 {style['pitch']})"
        )
        per_scene_words = synthesize_all_narrations(
            [s["narration"] for s in prepared], narration_path, style
        )
        words_path.write_text(
            json.dumps(per_scene_words, ensure_ascii=False), encoding="utf-8"
        )

    from moviepy import AudioFileClip

    with AudioFileClip(str(narration_path)) as probe:
        narration_duration = probe.duration

    # 장면 경계는 그 장면의 첫 단어가 발음되기 시작하는 시점이다. 이렇게 잡으면
    # 그림이 바뀌는 순간과 말이 넘어가는 순간이 정확히 맞는다. 첫 장면만 0에서 연다.
    scenes: list[dict] = []
    for i, (raw_scene, words) in enumerate(zip(prepared, per_scene_words)):
        scene_start = 0.0 if i == 0 else words[0]["start"]
        if i + 1 < len(per_scene_words):
            scene_end = per_scene_words[i + 1][0]["start"]
        else:
            scene_end = narration_duration + SCENE_TAIL_PADDING

        scenes.append(
            {
                **raw_scene,
                # 자막은 장면 클립 안에서 그려지므로 장면 기준 시각으로 바꿔 둔다.
                "words": [
                    {**w, "start": max(w["start"] - scene_start, 0.0)} for w in words
                ],
                "duration": max(scene_end - scene_start, 0.4),
                "start": scene_start,
            }
        )

    cursor = scenes[-1]["start"] + scenes[-1]["duration"]

    total = math.ceil(cursor)
    print(f"\n=== 타임라인 (총 약 {total}초) ===")
    print(format_timeline(scenes))

    (work_dir / "timeline.txt").write_text(
        format_timeline(scenes) + f"\n\n총 길이: 약 {total}초\n", encoding="utf-8"
    )

    if args.skip_video:
        print(f"\n--skip-video 지정됨. 소재만 저장했습니다 -> {work_dir.resolve()}")
        return

    print("\n5) 영상 합성 중... (이미지 줌 + 단어 자막 + SFX + BGM)")
    out_path = build_video(
        storyboard, scenes, work_dir / "final.mp4", narration_path
    )
    print(f"\n완료! -> {out_path.resolve()}")


if __name__ == "__main__":
    main()

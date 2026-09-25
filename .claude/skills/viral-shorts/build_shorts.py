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
# 음원넣기.bat(import_audio.py)으로 사장님이 직접 넣은 소리는 여기 따로 둔다.
# 기본 음원 폴더에 덮어쓰면 저장소를 업데이트할 때 충돌하거나 원본이 사라진다.
# 같은 이름이 양쪽에 있으면 직접 넣은 쪽이 이긴다.
USER_SFX_DIR = SKILL_DIR / "assets" / "user" / "sfx"
USER_BGM_DIR = SKILL_DIR / "assets" / "user" / "bgm"
# 효과음·배경음악 이름 목록은 웹과 같이 쓰는 파일 하나에서 읽는다.
AUDIO_CATALOG_PATH = PROJECT_ROOT / "src" / "lib" / "audioCatalog.json"

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
# 장면 하나가 화면에 떠 있는 최소 시간. 장면 길이는 그 장면 대사 길이로 정해지는데,
# "세 시간째." 같은 짧은 대사면 사진이 1초 만에 휙 지나가 무슨 사진인지 보기도 전에
# 넘어간다(장면 수를 늘릴수록 심해진다). 대사가 짧으면 사진을 이만큼은 보여주고,
# 다음 대사를 그만큼 늦게 시작한다 — 짧은 한마디 뒤의 "한 박자 쉼"이 된다.
MIN_SCENE_SECONDS = 2.4
# 웹에서 장면 길이를 직접 정할 때 받아주는 최대값(웹 화면의 SCENE_SECONDS_MAX와 같다).
MAX_WANTED_SCENE_SECONDS = 15.0
# 목소리를 잘라 사이를 띄울 때 이음매에서 "틱" 소리가 나지 않게 살짝 줄인다.
NARRATION_SEAM_FADE = 0.03
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
# 스토리보드에 bgmMood가 없을 때 쓰는 값. 자막 색·목소리 톤·BGM이 전부 이걸 보므로
# 한 군데서만 정한다 — 예전엔 자막은 playful, BGM은 mystery로 갈려 서로 안 맞았다.
DEFAULT_BGM_MOOD = "playful"
# 장면 사이에는 쉼표만 넣는다. 마침표로 끊으면 TTS가 끝을 내려 읽어 단절감이 생긴다.
# 단 줄이 이미 느낌표·물음표·말줄임표로 끝났다면 쉼표를 붙이지 않는다. "들어있어!,"
# 처럼 붙여 보내면 음성엔진이 그 뒤의 쉼표를 보고 평범한 쉼으로 읽어버려서,
# 대본에 힘들여 넣은 억양 신호가 엔진에 닿기도 전에 지워진다.
NARRATION_JOINER = ", "
SENTENCE_ENDINGS = ("!", "?", ".", "…")
KEN_BURNS_ZOOM = 1.12
BGM_GAIN = 10 ** (-15 / 20)  # 요구사항: BGM -15dB 감쇄
# 효과음은 장면이 바뀌는 순간을 찍어주는 짧은 큐다. 그런데 음원 라이브러리에는
# 17초짜리 트레일러 붐처럼 긴 파일이 섞여 있어서, 그대로 깔면 큐가 아니라 배경음이
# 되어 나레이션을 덮는다. 길이를 여기서 강제한다 — 파일을 일일이 손보는 것보다
# 낫다. 나중에 어떤 음원을 새로 넣어도 같은 사고가 안 난다.
SFX_MAX_SECONDS = 2.0
SFX_FADE_SECONDS = 0.15  # 잘린 끝에서 딱 소리가 나지 않게
# 음원마다 녹음 레벨이 제각각이다 — 트레일러 붐은 RMS 0.45로 나레이션(약 0.11)보다
# 크고, UI 핑은 0.01로 안 들린다. 고정 배율을 곱하면 한쪽은 대사를 덮고 다른 쪽은
# 묻히므로, 파일마다 실제 레벨을 재서 같은 높이로 맞춘다.
SFX_TARGET_RMS = 0.05  # 나레이션보다 확실히 아래
SFX_MAX_GAIN = 4.0  # 너무 조용한 파일을 억지로 키우면 잡음까지 커진다

# 기계 음성은 여섯 줄을 전부 같은 세기로 읽는다. 사람이 썰을 풀 때는 훅에서 들뜨고,
# 반전에서 터뜨리고, 마지막은 툭 떨어뜨리는데 그 강약이 통째로 없다. 읽힌 뒤에
# 대목별로 음량을 조금씩 달리해서 그 곡선을 입힌다. ±2dB 남짓이라 "소리가 커졌다"가
# 아니라 "여기가 중요하구나"로 들리는 정도다.
NARRATION_HOOK_GAIN = 10 ** (2.0 / 20)
NARRATION_TWIST_GAIN = 10 ** (2.5 / 20)
NARRATION_CLOSE_GAIN = 10 ** (-1.5 / 20)
# 반전 장면은 대본이 고른 효과음으로 알아낸다 — 스토리보드가 이미 그 자리에 이
# 큐들을 넣게 되어 있어서, 장면 번호로 넘겨짚는 것보다 정확하다.
TWIST_CUES = {"reveal", "laugh", "boom", "impact", "triumph", "fanfare", "boing"}
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


CHARACTER_DIR = SKILL_DIR / "characters"


def load_character(value: str | None) -> str | None:
    """--character 값을 실제 외모 설명으로 바꾼다.

    characters/ 폴더에 같은 이름의 txt가 있으면 그 내용을 쓰고, 없으면 적어주신
    말을 그대로 쓴다. 외모 설명은 영어로 길게 써야 그림이 제대로 나오는데, 그걸
    매번 명령줄에 타이핑하게 하면 쓰지 않게 된다.
    """
    if not value:
        return None
    preset = CHARACTER_DIR / f"{value}.txt"
    if preset.exists():
        return " ".join(preset.read_text(encoding="utf-8").split())
    return value.strip()


def fetch_storyboard(
    config: dict, token: str, topic: str, character: str | None = None
) -> dict:
    payload: dict = {"topic": topic}
    if character:
        payload["character"] = character
    return _http_post_json(
        f"{config['base_url']}/api/shorts/storyboard",
        payload,
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
    """글자만 남긴다(한글·자모·영숫자). 공백과 문장부호는 모두 뺀다.

    장면을 나눌 때 쓰는 자라서, 음성엔진이 단어를 돌려줄 때 문장부호를 붙여주든
    떼어버리든 같은 길이가 나와야 한다. 부호를 세다가는 엔진이 "어?"를 "어"로
    돌려주는 것만으로 장면 경계가 한 칸씩 밀린다.
    """
    return re.sub(r"[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]", "", text)


def _join_narrations(narrations: list[str]) -> str:
    """줄을 한 문장으로 잇는다. 이미 부호로 끝난 줄에는 쉼표를 덧붙이지 않는다."""
    parts: list[str] = []
    for i, line in enumerate(narrations):
        text = line.strip()
        parts.append(text)
        if i < len(narrations) - 1:
            parts.append(" " if text.endswith(SENTENCE_ENDINGS) else NARRATION_JOINER)
    return "".join(parts)


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
    # 나레이션이 빈 장면(그림·효과음만 보여주는 컷)은 읽을 게 없으니 빼고 읽힌다.
    # 넣은 채로 글자 수를 맞추면 빈 장면 몫이 0이라 단어가 하나도 배정되지 않거나
    # (마지막 장면이면 "빈 장면" 오류로 멈춘다), 다음 장면 단어를 빼앗아 경계가 밀린다.
    voiced = [i for i, n in enumerate(narrations) if _ink(n)]
    if not voiced:
        raise RuntimeError("나레이션이 있는 장면이 하나도 없습니다. 대본을 확인해주세요.")
    spoken = [narrations[i] for i in voiced]
    joined = _join_narrations(spoken)
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
    targets = [len(_ink(n)) for n in spoken]
    per_spoken: list[list[dict]] = [[] for _ in spoken]
    index = 0
    filled = 0
    for word in words:
        if index < len(spoken) - 1 and filled >= targets[index]:
            index += 1
            filled = 0
        per_spoken[index].append(word)
        filled += len(_ink(word["text"]))

    per_scene: list[list[dict]] = [[] for _ in narrations]
    for slot, scene_index in enumerate(voiced):
        per_scene[scene_index] = per_spoken[slot]

    empty = [voiced[i] + 1 for i, chunk in enumerate(per_spoken) if not chunk]
    if empty:
        raise RuntimeError(
            f"나레이션을 장면별로 나누지 못했습니다(빈 장면: {empty}). "
            "--regenerate 로 다시 시도해주세요."
        )
    return per_scene


# --------------------------------------------------------------------------
# 이미지 전처리
# --------------------------------------------------------------------------

def _cover(image, width: int, height: int):
    """비율을 지키며 width x height를 꽉 채우도록 가운데를 잘라 맞춘다."""
    from PIL import Image

    target_ratio = width / height
    src_ratio = image.width / image.height
    if src_ratio > target_ratio:
        new_width = int(image.height * target_ratio)
        left = (image.width - new_width) // 2
        image = image.crop((left, 0, left + new_width, image.height))
    else:
        new_height = int(image.width / target_ratio)
        top = (image.height - new_height) // 2
        image = image.crop((0, top, image.width, top + new_height))
    return image.resize((width, height), Image.LANCZOS)


# 상품 사진을 통째로 보여줄 때 상품이 차지할 최대 영역. 위쪽은 제목·후기 카드 자리라
# 가운데보다 조금 아래에 둔다(세 줄짜리 후기 카드 아래 끝이 화면의 약 31%). 좌우는
# 버튼 자리를 조금 남긴다.
CONTAIN_MAX_WIDTH = int(VIDEO_WIDTH * 0.92)
CONTAIN_MAX_HEIGHT = int(VIDEO_HEIGHT * 0.42)
CONTAIN_CENTER_Y = int(VIDEO_HEIGHT * 0.55)


def fit_to_frame(src: Path, dest: Path, mode: str = "cover") -> Path:
    """이미지를 1080x1920 한 장으로 만든다(비율 왜곡 없이).

    cover  : 화면을 꽉 채우도록 가운데를 잘라낸다. 풍경·인물 사진용.
    contain: 상품 사진용. 쇼핑몰 상품 사진은 대개 정사각형이라 cover로 자르면 상품
             양옆이 잘려 나간다. 상품은 통째로 가운데에 두고, 남는 곳은 같은 사진을
             크게 흐리게 깔아 채운다(검은 띠보다 훨씬 덜 허전해 보인다).
    """
    from PIL import Image, ImageEnhance, ImageFilter

    image = Image.open(src).convert("RGB")
    if mode != "contain":
        _cover(image, VIDEO_WIDTH, VIDEO_HEIGHT).save(dest)
        return dest

    background = _cover(image, VIDEO_WIDTH, VIDEO_HEIGHT).filter(
        ImageFilter.GaussianBlur(40)
    )
    background = ImageEnhance.Brightness(background).enhance(0.6)

    scale = min(CONTAIN_MAX_WIDTH / image.width, CONTAIN_MAX_HEIGHT / image.height)
    product = image.resize(
        (max(1, int(image.width * scale)), max(1, int(image.height * scale))),
        Image.LANCZOS,
    )
    left = (VIDEO_WIDTH - product.width) // 2
    top = CONTAIN_CENTER_Y - product.height // 2
    background.paste(product, (left, top))
    background.save(dest)
    return dest


# --------------------------------------------------------------------------
# 구매자 후기 카드
# --------------------------------------------------------------------------

# 쇼핑 쇼츠에서 가장 믿음을 주는 건 진행자의 말이 아니라 실제 구매자의 한 줄이다.
# 후기를 나레이션으로만 읽으면 "지어낸 말"처럼 들리므로, 화면에 쇼핑몰 후기처럼 생긴
# 카드로 같이 띄운다. 위치는 제목(첫 1.6초)이 지나간 뒤의 상단 — 상품(가운데)과
# 자막(아래)을 가리지 않는다.
REVIEW_CARD_WIDTH = int(VIDEO_WIDTH * 0.8)
REVIEW_CARD_Y = int(VIDEO_HEIGHT * 0.14)
REVIEW_CARD_MAX_LINES = 3
REVIEW_CARD_PADDING = 36
REVIEW_TEXT_SIZE = 50
REVIEW_LABEL_SIZE = 34


def _wrap_korean(draw, text: str, font, max_width: int) -> list[str]:
    """글자 단위로 폭에 맞춰 줄을 나눈다. 한글 후기는 띄어쓰기가 불규칙해서
    단어 단위로 자르면 한 줄이 넘치거나 너무 짧아진다."""
    lines: list[str] = []
    current = ""
    for char in text:
        if char == "\n":
            lines.append(current)
            current = ""
            continue
        trial = current + char
        if draw.textlength(trial, font=font) <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = char.lstrip()
    if current:
        lines.append(current)
    return lines


def render_review_card(quote: str, dest: Path, rating: int = 5) -> Path:
    """"★★★★★ 구매자 후기" + 인용문이 들어간 반투명 카드를 투명 PNG로 그린다."""
    from PIL import Image, ImageDraw, ImageFont

    text_font = ImageFont.truetype(str(FONT_PATH), REVIEW_TEXT_SIZE)
    label_font = ImageFont.truetype(str(FONT_PATH), REVIEW_LABEL_SIZE)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))

    inner_width = REVIEW_CARD_WIDTH - REVIEW_CARD_PADDING * 2
    lines = _wrap_korean(probe, f"“{quote.strip()}”", text_font, inner_width)
    if len(lines) > REVIEW_CARD_MAX_LINES:
        # 카드가 화면을 덮지 않게 세 줄에서 자르고 말줄임표를 붙인다.
        lines = lines[:REVIEW_CARD_MAX_LINES]
        last = lines[-1]
        while last and probe.textlength(last + "…”", font=text_font) > inner_width:
            last = last[:-1]
        lines[-1] = last + "…”"

    rating = min(max(int(rating), 1), 5)
    label = "★" * rating + "☆" * (5 - rating) + "  구매자 후기"
    line_height = int(REVIEW_TEXT_SIZE * 1.35)
    label_height = int(REVIEW_LABEL_SIZE * 1.6)
    height = REVIEW_CARD_PADDING * 2 + label_height + line_height * len(lines)

    card = Image.new("RGBA", (REVIEW_CARD_WIDTH, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(card)
    draw.rounded_rectangle(
        (0, 0, REVIEW_CARD_WIDTH - 1, height - 1), radius=32, fill=(255, 255, 255, 235)
    )
    x = REVIEW_CARD_PADDING
    y = REVIEW_CARD_PADDING
    draw.text((x, y), label, font=label_font, fill=(245, 166, 35, 255))
    y += label_height
    for line in lines:
        draw.text((x, y), line, font=text_font, fill=(24, 24, 27, 255))
        y += line_height
    card.save(dest)
    return dest


def image_fit(storyboard: dict, scene: dict) -> str:
    """장면 사진을 어떻게 화면에 맞출지. 장면 값이 있으면 그걸, 없으면 영상 전체 값을 쓴다."""
    return scene.get("imageFit") or storyboard.get("imageFit") or "cover"


def download_video(config: dict, token: str, url: str, dest: Path) -> Path:
    """AI 영상 쇼츠의 장면 클립(mp4)을 /api/download 프록시로 받아온다.

    이유는 download_image와 같다 — 회사망 프록시가 미분류 CDN 도메인을 가로채는
    환경에서 직접 받으면 차단 안내 페이지가 대신 내려온다.
    """
    proxied = (
        f"{config['base_url']}/api/download?url={urllib.parse.quote(url, safe='')}"
    )
    request = urllib.request.Request(
        proxied, headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = response.read()
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"영상 클립 다운로드 실패 ({err.code}): {raw}") from err

    if len(payload) < 100:
        raise RuntimeError(
            f"내려받은 영상 클립이 비정상적으로 작습니다({len(payload)} bytes). "
            "네트워크가 응답을 가로챘을 수 있습니다."
        )

    dest.write_bytes(payload)
    return dest


def fit_video_to_frame(clip):
    """AI 생성 영상 클립을 1080x1920에 꽉 차게 잘라 맞춘다(비율 왜곡 없이).

    fit_to_frame(이미지용)과 같은 계산이지만 프레임마다 다시 계산할 필요 없이
    moviepy의 Crop/Resize 이펙트로 한 번만 지시한다. 소리는 우리 나레이션
    트랙만 쓰므로 공급자가 혹시 넣었을 수 있는 오디오는 버린다.
    """
    from moviepy import vfx

    clip = clip.without_audio()
    target_ratio = VIDEO_WIDTH / VIDEO_HEIGHT
    src_ratio = clip.w / clip.h

    if src_ratio > target_ratio:
        new_width = int(clip.h * target_ratio)
        x1 = (clip.w - new_width) // 2
        clip = clip.with_effects([vfx.Crop(x1=x1, width=new_width, height=clip.h)])
    else:
        new_height = int(clip.w / target_ratio)
        y1 = (clip.h - new_height) // 2
        clip = clip.with_effects([vfx.Crop(y1=y1, width=clip.w, height=new_height)])

    return clip.with_effects([vfx.Resize((VIDEO_WIDTH, VIDEO_HEIGHT))])


# 장면 클립 길이와 그 장면에 배정된 나레이션 길이가 정확히 같을 일은 거의 없다
# (AI 영상 생성은 5초 단위로 끊기고, 나레이션은 사람이 읽는 실측 길이라서). 그
# 차이를 메우는 방법:
# - 클립이 더 길면: 앞부분만 쓰고 자른다(뒷부분을 버리는 대신 나레이션에 맞는
#   길이만큼만 보여준다 — 이야기 흐름이 나레이션을 따라가므로 이게 맞다).
# - 클립이 더 짧으면: 마지막 프레임을 정지시켜 남는 시간을 채운다. 나레이션을
#   빨리 감거나 마지막 장면을 무작정 늘리는 것보다, 이 방식이 화면이 부자연스럽게
#   점프하지 않는 가장 값싼 보완이다. 차이가 크면(예: 5초 클립에 15초를 채워야
#   하면) 정지 구간이 티 나므로, 장면 설계 단계에서애초에 나레이션 분량과 클립
#   길이를 비슷하게 맞추는 게 근본 해법이다(후속 개선 대상).
def match_clip_duration(clip, duration: float):
    from moviepy import vfx

    if clip.duration is None:
        return clip.with_duration(duration)
    if clip.duration > duration + 0.02:
        return clip.subclipped(0, duration)
    if clip.duration < duration - 0.02:
        last_frame_t = max(clip.duration - 1.0 / (clip.fps or FPS), 0.0)
        return clip.with_effects(
            [vfx.Freeze(t=last_frame_t, total_duration=duration)]
        )
    return clip.with_duration(duration)


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
    duration: float,
    thumbnail_copy: str = "",
    ken_burns: bool = True,
    mood: str = "playful",
):
    """장면 1개: 배경(정지 이미지+Ken Burns 또는 AI 영상 클립) + 단어별 자막
    (+ 첫 장면이면 썸네일 카피)."""
    from moviepy import CompositeVideoClip, ImageClip, VideoFileClip

    if scene.get("video_path"):
        # AI 영상 쇼츠: 이미 움직이는 클립이라 Ken Burns를 또 얹지 않는다(이중으로
        # 줌까지 걸리면 어지럽다). 길이만 나레이션 타이밍에 맞춘다.
        raw = VideoFileClip(str(scene["video_path"]))
        background = match_clip_duration(
            fit_video_to_frame(raw), duration
        ).with_position(("center", "center"))
    else:
        still = ImageClip(str(scene["image_path"])).with_duration(duration)
        # Ken Burns는 매 프레임 리사이즈라 렌더 시간의 대부분을 차지한다. 자막·타이밍만
        # 빠르게 확인하고 싶을 때는 끌 수 있게 해둔다.
        background = (
            _ken_burns(still, duration, scene.get("kenBurns", "in"))
            if ken_burns
            else still.with_position(("center", "center"))
        )

    layers = [background]
    if scene.get("review_card_path"):
        # 첫 장면 제목과 겹치지 않도록 제목이 떠 있는 동안은 기다렸다가 띄운다.
        card_start = min(THUMBNAIL_COPY_SECONDS if thumbnail_copy else 0.15, duration)
        if duration - card_start > 0.1:
            layers.append(
                ImageClip(str(scene["review_card_path"]))
                .with_start(card_start)
                .with_duration(duration - card_start)
                .with_position(("center", REVIEW_CARD_Y))
            )
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
        style = TITLE_STYLES.get(mood_family(mood), DEFAULT_TITLE_STYLE)
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


def load_bgm_families() -> dict:
    """분위기 이름 -> 파일이 꼭 있는 기본 분위기(mystery/epic/playful/dreamy).

    "공포"처럼 사장님이 직접 채우는 칸은 비어 있을 수 있다. 그때 음악이 통째로
    빠지는 대신 가장 비슷한 기본 곡을 쓰고, 제목 색·목소리 톤도 그 계열을 따른다.
    """
    try:
        catalog = json.loads(AUDIO_CATALOG_PATH.read_text(encoding="utf-8"))
        return {entry["mood"]: entry["family"] for entry in catalog["bgm"]}
    except (OSError, ValueError, KeyError):
        return {}


BGM_FAMILIES = load_bgm_families()


def mood_family(mood: str) -> str:
    """제목 색·목소리 톤을 정할 때 쓰는 기본 분위기."""
    return BGM_FAMILIES.get(mood, mood)


def find_sfx(cue: str):
    """효과음 파일을 찾는다. 직접 넣은 것 -> 기본 제공 순. 없으면 None."""
    for folder in (USER_SFX_DIR, SFX_DIR):
        path = folder / f"{cue}.mp3"
        if path.exists():
            return path
    return None


def find_bgm(mood: str):
    """배경음악 파일을 찾는다. 그 분위기 파일이 없으면 비슷한 기본 곡으로 물러선다."""
    for name in dict.fromkeys((mood, mood_family(mood))):
        for folder in (USER_BGM_DIR, BGM_DIR):
            path = folder / f"{name}.mp3"
            if path.exists():
                return path
    return None


def sfx_length(clip_duration: float, scene_duration: float) -> float:
    """효과음을 실제로 몇 초만 쓸지 정한다. 짧은 파일은 그대로 둔다."""
    return min(clip_duration, SFX_MAX_SECONDS, scene_duration)


def sfx_gain(measured_rms: float) -> float:
    """잰 레벨을 목표 레벨로 끌어올리거나 내리는 배율."""
    if measured_rms <= 1e-6:  # 무음 파일 — 건드릴 것도 없고 0으로 나누면 터진다
        return 1.0
    return min(SFX_TARGET_RMS / measured_rms, SFX_MAX_GAIN)


def measure_rms(path: Path) -> float:
    """음원의 실제 음량을 잰다. 실제로 쓰는 앞부분만 본다.

    MoviePy의 to_soundarray는 1초 단위 버퍼를 전제해서, 1초보다 짧은 파일에 쓰면
    t=1.0초를 읽으려다 IOError로 죽는다(laugh 0.74초, pop 0.67초가 여기 걸렸다).
    시간으로 찾아 읽는 대신 프레임을 통째로 읽어서 그 버그를 피한다.
    """
    import numpy as np
    from moviepy import AudioFileClip

    with AudioFileClip(str(path)) as clip:
        reader = clip.reader
        reader.seek(0)
        frames = reader.read_chunk(
            min(reader.n_frames, int(clip.fps * SFX_MAX_SECONDS))
        )
    return float(np.sqrt((frames**2).mean()))


def voice_segments(
    raw_scenes: list[dict],
    per_scene_words: list[list[dict]],
    narration_duration: float,
) -> list[dict]:
    """장면마다 통째로 읽힌 나레이션에서 자기 목소리 구간(start, duration)을 찾는다.

    말하는 장면의 경계는 그 장면 첫 단어가 발음되는 시점이다(첫 말하는 장면만 0).
    이렇게 잡으면 그림이 바뀌는 순간과 말이 넘어가는 순간이 정확히 맞는다.
    나레이션이 빈 장면은 목소리 구간이 0초이고, 바로 앞 목소리가 끝난 자리에 놓인다.
    """
    voiced = [i for i, words in enumerate(per_scene_words) if words]
    bounds: dict[int, tuple[float, float]] = {}
    for position, i in enumerate(voiced):
        start = 0.0 if position == 0 else per_scene_words[i][0]["start"]
        if position + 1 < len(voiced):
            end = per_scene_words[voiced[position + 1]][0]["start"]
        else:
            end = narration_duration + SCENE_TAIL_PADDING
        bounds[i] = (start, max(end - start, 0.4))

    scenes: list[dict] = []
    cursor = 0.0
    for i, (raw_scene, words) in enumerate(zip(raw_scenes, per_scene_words)):
        start, duration = bounds.get(i, (cursor, 0.0))
        cursor = start + duration
        scenes.append(
            {
                **raw_scene,
                # 자막은 장면 클립 안에서 그려지므로 장면 기준 시각으로 바꿔 둔다.
                "words": [{**w, "start": max(w["start"] - start, 0.0)} for w in words],
                "duration": duration,
                "start": start,
            }
        )
    return scenes


def wanted_seconds(scene: dict) -> float | None:
    """웹에서 사용자가 직접 정한 장면 길이(초). 없거나 이상한 값이면 None(자동)."""
    value = scene.get("seconds")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return min(float(value), MAX_WANTED_SCENE_SECONDS)


def hold_short_scenes(scenes: list[dict], min_seconds: float = MIN_SCENE_SECONDS) -> bool:
    """장면 길이를 정하고, 늘어난 만큼 뒤 장면들을 뒤로 민다.

    사용자가 초를 정한 장면(scene["seconds"])은 그 길이로, 아니면 대사가 짧은
    장면만 min_seconds까지 늘린다. 어느 쪽이든 대사를 읽는 시간보다 짧게는 못
    자른다 — 자르면 다음 장면 그림 위로 말이 넘어간다.

    각 장면에 원래 목소리 구간(voice_start, voice_duration)을 남겨 둔다 — 합성할 때
    목소리를 그 구간대로 잘라 새 시작 시각에 붙인다. 길이가 바뀐 장면이 하나라도
    있으면 True를 돌려준다(없으면 목소리를 자르지 않고 예전처럼 한 덩어리로 쓴다).
    """
    cursor = 0.0
    changed = False
    for scene in scenes:
        scene["voice_start"] = scene["start"]
        scene["voice_duration"] = scene["duration"]
        wanted = wanted_seconds(scene)
        if wanted is not None:
            target = max(wanted, scene["duration"])
        else:
            target = max(scene["duration"], min_seconds)
        if abs(target - scene["duration"]) > 0.001:
            changed = True
        scene["duration"] = target
        scene["start"] = cursor
        cursor += scene["duration"]
    return changed


def _narration_gain(index: int, last_index: int, scene: dict) -> float:
    """대목별 강약: 훅은 들뜨게, 반전은 세게, 마무리는 툭 떨어뜨린다."""
    if index == 0:
        return NARRATION_HOOK_GAIN
    if index == last_index:
        return NARRATION_CLOSE_GAIN
    if scene.get("sfx") in TWIST_CUES:
        return NARRATION_TWIST_GAIN
    return 1.0


def _held_narration_tracks(scenes: list[dict], narration) -> list:
    """목소리를 장면별 원래 구간대로 잘라, 늘어난 장면 시각에 맞춰 다시 놓는다."""
    from moviepy import afx

    tracks = []
    last_index = len(scenes) - 1
    for i, scene in enumerate(scenes):
        start = scene["voice_start"]
        end = min(start + scene["voice_duration"], narration.duration)
        if end - start <= 0.01:
            continue
        piece = narration.subclipped(start, end)
        # 뒤에 쉼이 생기는 조각만 끝을 살짝 줄인다. 이어 붙는 조각은 원래대로 둬야
        # 한 문장처럼 이어 읽힌 억양이 그대로 남는다.
        if scene["duration"] > scene["voice_duration"] + 0.01:
            piece = piece.with_effects([afx.AudioFadeOut(NARRATION_SEAM_FADE)])
        gain = _narration_gain(i, last_index, scene)
        if gain != 1.0:
            piece = piece.with_volume_scaled(gain)
        tracks.append(piece.with_start(scene["start"]))
    return tracks


def build_audio(
    scenes: list[dict],
    total_duration: float,
    bgm_mood: str,
    narration_path: Path,
):
    """나레이션 + 장면별 SFX + 루프 BGM(-15dB)을 한 트랙으로 섞는다."""
    from moviepy import AudioFileClip, CompositeAudioClip, afx

    narration = AudioFileClip(str(narration_path))
    held = any(
        abs(scene.get("voice_start", scene["start"]) - scene["start"]) > 0.001
        or abs(scene.get("voice_duration", scene["duration"]) - scene["duration"]) > 0.001
        for scene in scenes
    )
    if held:
        # 짧은 장면을 늘렸으면(hold_short_scenes) 목소리를 장면별로 잘라 다시 놓는다.
        tracks = _held_narration_tracks(scenes, narration)
    else:
        # 나레이션은 통째로 한 트랙이다. 장면마다 잘라 붙이면 이어 읽힌 억양이
        # 이음매에서 다시 끊기므로 자르지 않는다. 대신 구간별 음량만 얹는다.
        shaping = []
        last_index = len(scenes) - 1
        for i, scene in enumerate(scenes):
            factor = _narration_gain(i, last_index, scene)
            if factor == 1.0:
                continue
            shaping.append(
                afx.MultiplyVolume(
                    factor,
                    start_time=scene["start"],
                    end_time=scene["start"] + scene["duration"],
                )
            )
        if shaping:
            narration = narration.with_effects(shaping)
        tracks = [narration.with_start(0)]

    for scene in scenes:
        cue = scene.get("sfx", "none")
        if cue and cue != "none":
            sfx_path = find_sfx(cue)
            if sfx_path:
                clip = AudioFileClip(str(sfx_path))
                clip = clip.subclipped(
                    0, sfx_length(clip.duration, scene["duration"])
                ).with_effects([afx.AudioFadeOut(SFX_FADE_SECONDS)])
                gain = sfx_gain(measure_rms(sfx_path))
                tracks.append(
                    clip.with_volume_scaled(gain).with_start(scene["start"])
                )
            else:
                print(f"    (효과음 없음: {cue}.mp3 — 건너뜀. 음원넣기.bat으로 채울 수 있어요)")

    bgm_path = find_bgm(bgm_mood)
    if bgm_path and bgm_path.stem != bgm_mood:
        print(f"    ({bgm_mood} 음악이 아직 없어서 비슷한 {bgm_path.stem} 곡을 씁니다)")
    if bgm_path:
        bgm = AudioFileClip(str(bgm_path)).with_effects(
            [afx.AudioLoop(duration=total_duration)]
        )
        tracks.append(bgm.with_volume_scaled(BGM_GAIN).with_start(0))
    else:
        print(f"    (BGM 없음: {bgm_mood}.mp3 — 건너뜀)")

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
    mood = storyboard.get("bgmMood", DEFAULT_BGM_MOOD)

    clips = [
        build_scene_clip(
            scene,
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
            storyboard.get("bgmMood", DEFAULT_BGM_MOOD),
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
    # 자른 뒤에 '-'가 끝에 남을 수 있어(예: 30번째 글자가 구분자) 한 번 더 떼어낸다.
    return (slug or "shorts")[:max_length].rstrip("-") or "shorts"


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
    parser.add_argument(
        "--character",
        default=None,
        help="등장인물. characters/ 폴더의 파일 이름(예: 흑돼지) 또는 영어 외모 설명을 "
        "직접 적는다. 생략하면 기본 인물(한국 여성)로 만든다. --topic 에서만 쓰인다",
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

    # 설정을 읽고 로그인하는 건 서버를 실제로 부르는 순간까지 미룬다. 이미 받아둔
    # 소재로 영상만 다시 뽑을 때(--storyboard + 이미지 재사용)는 네트워크가 아예
    # 필요 없는데, 먼저 로그인해버리면 계정 정보가 없는 PC에서 그 재실행이 통째로
    # 막힌다 — 문서에 적어둔 사용법인데 실제로는 못 쓰고 있었다.
    _auth: dict = {}

    def auth() -> tuple[dict, str]:
        if not _auth:
            config = load_config()
            print("1) 로그인 중...")
            _auth["config"] = config
            _auth["token"] = sign_in(config)
        return _auth["config"], _auth["token"]

    if args.project:
        storyboard = json.loads(Path(args.project).read_text(encoding="utf-8"))
        print(f"2) 웹에서 만든 프로젝트 사용: {args.project}")
    elif args.storyboard:
        storyboard = json.loads(Path(args.storyboard).read_text(encoding="utf-8"))
        print(f"2) 기존 스토리보드 사용: {args.storyboard}")
    else:
        print("2) 스토리보드(6장면 대본·이미지프롬프트·SFX) 생성 중...")
        character = load_character(args.character)
        if character:
            print(f"   캐릭터: {args.character}")
        storyboard = fetch_storyboard(*auth(), args.topic, character)

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

    # 나레이션을 먼저 만든다. 공짜인데다 장면별로 쪼개다 실패할 수 있는 단계라서,
    # 이걸 이미지(장당 실제 비용) 앞에 두어야 실패해도 돈이 안 나간다.
    narration_path = work_dir / "audio" / "narration.mp3"
    words_path = work_dir / "audio" / "narration.words.json"
    if narration_path.exists() and words_path.exists() and not args.regenerate:
        print("3) 나레이션 재사용")
        per_scene_words = json.loads(words_path.read_text(encoding="utf-8"))
    else:
        mood = storyboard.get("bgmMood", DEFAULT_BGM_MOOD)
        style = dict(VOICE_STYLES.get(mood_family(mood), DEFAULT_VOICE_STYLE))
        if args.voice:
            style["voice"] = args.voice
        print(
            f"3) 나레이션 {len(storyboard['scenes'])}줄을 한 번에 합성하는 중... "
            f"({mood} 톤 · {style['voice']} · 속도 {style['rate']} · 높이 {style['pitch']})"
        )
        per_scene_words = synthesize_all_narrations(
            [s["narration"] for s in storyboard["scenes"]], narration_path, style
        )
        words_path.write_text(
            json.dumps(per_scene_words, ensure_ascii=False), encoding="utf-8"
        )

    prepared: list[dict] = []
    for raw_scene in storyboard["scenes"]:
        index = raw_scene["index"]

        if raw_scene.get("videoUrl"):
            # AI 영상 쇼츠 결과물: 이미 만들어진 클립을 받아오기만 한다(생성 비용은
            # 웹에서 장면을 만들 때 이미 치렀다 — 여기서 다시 만들지 않는다).
            video_path = work_dir / "videos" / f"scene_{index}.mp4"
            video_path.parent.mkdir(parents=True, exist_ok=True)
            if video_path.exists() and not args.regenerate:
                print(f"4-{index}) 장면 {index} 영상 클립 재사용")
            else:
                print(f"4-{index}) 장면 {index} 영상 클립 내려받는 중...")
                config, token = auth()
                download_video(config, token, raw_scene["videoUrl"], video_path)
            prepared.append({**raw_scene, "video_path": video_path})
            continue

        raw_path = work_dir / "images" / f"scene_{index}_raw.webp"
        image_path = work_dir / "images" / f"scene_{index}.png"

        # 같은 폴더로 다시 돌리면 이미 만든 소재를 재사용한다. 이미지는 생성할 때마다
        # 실제로 비용이 나가므로, 자막·효과음만 손보려고 재실행할 때 또 낼 이유가 없다.
        if image_path.exists() and not args.regenerate:
            print(f"4-{index}) 장면 {index} 이미지 재사용")
        elif raw_scene.get("imageUrl"):
            # 웹에서 올린 이미지는 이미 있으니 받아오기만 하면 된다(생성 비용 없음).
            print(f"4-{index}) 장면 {index} 업로드 이미지 내려받는 중...")
            config, token = auth()
            download_image(config, token, raw_scene["imageUrl"], raw_path)
            fit_to_frame(raw_path, image_path, image_fit(storyboard, raw_scene))
        else:
            print(f"4-{index}) 장면 {index} 이미지 생성 중...")
            config, token = auth()
            download_image(
                config,
                token,
                generate_scene_image(config, token, raw_scene["imagePrompt"]),
                raw_path,
            )
            fit_to_frame(raw_path, image_path)

        prepared_scene = {**raw_scene, "image_path": image_path}
        if raw_scene.get("reviewQuote"):
            card_path = work_dir / "images" / f"review_{index}.png"
            render_review_card(
                raw_scene["reviewQuote"], card_path, raw_scene.get("reviewRating", 5)
            )
            prepared_scene["review_card_path"] = card_path
        prepared.append(prepared_scene)

    from moviepy import AudioFileClip

    with AudioFileClip(str(narration_path)) as probe:
        narration_duration = probe.duration

    # 장면 경계는 그 장면의 첫 단어가 발음되기 시작하는 시점이다. 이렇게 잡으면
    # 그림이 바뀌는 순간과 말이 넘어가는 순간이 정확히 맞는다. 첫 장면만 0에서 연다.
    # 나레이션이 빈 장면은 목소리 구간이 0초다 — 바로 앞 목소리가 끝난 자리에 놓이고,
    # 화면에 떠 있는 시간은 아래 hold_short_scenes가 정한다.
    scenes = voice_segments(prepared, per_scene_words, narration_duration)

    if hold_short_scenes(scenes):
        for s in scenes:
            wanted = wanted_seconds(s)
            if wanted is not None and wanted + 0.01 < s["voice_duration"]:
                print(
                    f"   (장면 {s['index']}: {wanted:.1f}초로 정했지만 대사가 "
                    f"{s['voice_duration']:.1f}초라 대사 길이에 맞춥니다)"
                )
        held = [
            s["index"]
            for s in scenes
            if wanted_seconds(s) is None and s["duration"] > s["voice_duration"] + 0.01
        ]
        custom = [s["index"] for s in scenes if wanted_seconds(s) is not None]
        if held:
            print(f"   (대사가 짧은 장면 {held}은 사진을 {MIN_SCENE_SECONDS}초까지 보여줍니다)")
        if custom:
            print(f"   (장면 {custom}은 웹에서 정한 길이로 보여줍니다)")
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

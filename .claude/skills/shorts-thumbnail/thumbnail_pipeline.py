"""
thumbnail_pipeline.py
----------------------
Claude Code 커스텀 스킬: 대본/주제 한 줄로 유튜브 쇼츠·인스타 릴스용 9:16 썸네일
여러 장을 한 번에 만드는 CLI 파이프라인.

새로 AI/합성 로직을 만들지 않고, 이미 배포된 ai-image-platform API 3개를 그대로
순서대로 호출한다 (문구·배경·합성 전부 서버 쪽 로직 그대로 재사용):
    1) POST /api/thumbnail/suggest  -> B급 감성 3~4단어 문구 + 영문 배경 프롬프트 추천
    2) POST /api/generate           -> 9:16("story") 배경 이미지 여러 장 생성 (Flux 1.1 Pro)
    3) POST /api/thumbnail/compose  -> 서버(@napi-rs/canvas)가 문구를 합성한 PNG를 반환

외부 파이썬 패키지가 전혀 필요 없다 (표준 라이브러리만 사용) — 합성은 서버가
@napi-rs/canvas로 처리하므로 이 스크립트는 Pillow나 폰트 파일을 몰라도 된다.

사용 예시:
    python thumbnail_pipeline.py --topic "퇴근 후 30분 홈트레이닝으로 뱃살 빼는 법"

    # 문구/배경 프롬프트를 직접 지정해 추천 호출(1단계)을 건너뛴다
    python thumbnail_pipeline.py --title "이것만은 꼭ㅋㅋㅋ" \
        --background-prompt "a dim home gym at night, dramatic side lighting, cinematic"

필요한 환경변수는 .env.example을 참고 (.env로 복사해서 사용).
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SKILL_DIR.parents[2]  # .claude/skills/shorts-thumbnail -> ai-image-platform

DEFAULT_BASE_URL = "https://ai-image-platform-lilac.vercel.app"


# --------------------------------------------------------------------------
# 환경변수 / 설정
# --------------------------------------------------------------------------

def _parse_env_file(path: Path) -> dict:
    """KEY=VALUE 형식의 .env 파일을 최소한으로 파싱한다 (주석 #, 빈 줄 무시)."""
    values: dict = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


class ConfigError(SystemExit):
    def __init__(self, message: str):
        super().__init__(f"설정 오류: {message}")


def load_config() -> dict:
    """스킬 전용 .env, 그리고(비어있으면) 프로젝트의 .env.local에서 값을 읽어온다.
    이미 셸에 설정된 환경변수가 항상 최우선이다."""
    skill_env = _parse_env_file(SKILL_DIR / ".env")
    for key, value in skill_env.items():
        os.environ.setdefault(key, value)

    email = os.environ.get("AI_PLATFORM_EMAIL", "").strip()
    password = os.environ.get("AI_PLATFORM_PASSWORD", "")
    if not email or not password:
        raise ConfigError(
            f"{SKILL_DIR / '.env'} 에 AI_PLATFORM_EMAIL / AI_PLATFORM_PASSWORD를 "
            "채워주세요 (.env.example 참고, 초대받은 계정 로그인 정보)."
        )

    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    supabase_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not supabase_url or not supabase_key:
        # 같은 저장소의 .env.local에 이미 있는 값(웹 앱과 동일한 publishable key)을
        # 재사용한다 — publishable key는 원래 공개되는 값이라 그대로 읽어도 안전하다.
        project_env = _parse_env_file(PROJECT_ROOT / ".env.local")
        supabase_url = supabase_url or project_env.get("NEXT_PUBLIC_SUPABASE_URL", "")
        supabase_key = supabase_key or project_env.get(
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ""
        )

    if not supabase_url or not supabase_key:
        raise ConfigError(
            "Supabase URL/키를 찾을 수 없습니다. .env에 SUPABASE_URL / "
            "SUPABASE_PUBLISHABLE_KEY를 직접 채우거나, ai-image-platform/.env.local이 "
            "있는지 확인해주세요."
        )

    base_url = (os.environ.get("AI_PLATFORM_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip(
        "/"
    )

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

def _http_post(url: str, payload: dict, headers: dict) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
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


def _http_post_json(url: str, payload: dict, headers: dict) -> dict:
    return json.loads(_http_post(url, payload, headers).decode("utf-8"))


def sign_in(supabase_url: str, supabase_key: str, email: str, password: str) -> str:
    """Supabase Auth REST API로 로그인해 access_token을 발급받는다."""
    url = f"{supabase_url}/auth/v1/token?grant_type=password"
    result = _http_post_json(
        url,
        {"email": email, "password": password},
        {"apikey": supabase_key},
    )
    token = result.get("access_token")
    if not token:
        raise RuntimeError(f"로그인에 실패했습니다: {result}")
    return token


def suggest_copy(base_url: str, token: str, topic: str) -> tuple[str, str]:
    result = _http_post_json(
        f"{base_url}/api/thumbnail/suggest",
        {"script": topic},
        {"Authorization": f"Bearer {token}"},
    )
    return result["title"], result["backgroundPrompt"]


def generate_backgrounds(base_url: str, token: str, prompt: str, count: int) -> list[str]:
    result = _http_post_json(
        f"{base_url}/api/generate",
        {"prompt": prompt, "format": "story"},
        {"Authorization": f"Bearer {token}"},
    )
    image_urls = result.get("imageUrls") or []
    if not image_urls:
        raise RuntimeError(f"배경 이미지를 받지 못했습니다: {result}")
    return image_urls[:count]


def compose_thumbnail(base_url: str, token: str, background_url: str, title: str) -> bytes:
    """서버(@napi-rs/canvas)에 배경 URL + 문구를 보내 합성된 PNG 바이트를 받는다."""
    return _http_post(
        f"{base_url}/api/thumbnail/compose",
        {"backgroundUrl": background_url, "title": title},
        {"Authorization": f"Bearer {token}"},
    )


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def slugify(text: str, max_length: int = 30) -> str:
    slug = re.sub(r"[^\w가-힣-]+", "-", text.strip()).strip("-")
    return (slug or "thumbnail")[:max_length]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="대본/주제로 쇼츠·릴스용 9:16 썸네일을 자동 생성합니다."
    )
    parser.add_argument("--topic", default=None, help="대본 한 줄 또는 키워드 (AI가 문구·배경 프롬프트 추천)")
    parser.add_argument("--title", default=None, help="메인 타이틀 문구를 직접 지정 (추천을 덮어씀)")
    parser.add_argument("--background-prompt", default=None, help="배경 생성용 영문 프롬프트를 직접 지정 (추천을 덮어씀)")
    parser.add_argument("--count", type=int, default=4, help="생성할 썸네일 장수 (1~4, 기본 4)")
    parser.add_argument("--out-dir", default="thumbnails", help="저장 폴더 (기본: ./thumbnails)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not args.topic and not (args.title and args.background_prompt):
        sys.exit(
            "오류: --topic을 입력하거나, --title과 --background-prompt를 함께 지정해주세요."
        )

    count = max(1, min(4, args.count))
    config = load_config()

    print("1) 로그인 중...")
    token = sign_in(config["supabase_url"], config["supabase_key"], config["email"], config["password"])

    title = args.title
    background_prompt = args.background_prompt
    if not title or not background_prompt:
        print("2) AI 문구·배경 프롬프트 추천 중... (B급 감성)")
        suggested_title, suggested_prompt = suggest_copy(config["base_url"], token, args.topic)
        title = title or suggested_title
        background_prompt = background_prompt or suggested_prompt
    print(f"   문구: {title}")
    print(f"   배경 프롬프트: {background_prompt}")

    print(f"3) 9:16 배경 이미지 {count}장 생성 중... (최대 1분 정도 걸릴 수 있어요)")
    image_urls = generate_backgrounds(config["base_url"], token, background_prompt, count)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = slugify(title)

    print("4) 서버에서 문구 합성 중...")
    saved_paths: list[str] = []
    for index, url in enumerate(image_urls, start=1):
        png_bytes = compose_thumbnail(config["base_url"], token, url, title)

        out_path = out_dir / f"{slug}_{index}.png"
        out_path.write_bytes(png_bytes)
        saved_paths.append(str(out_path))
        print(f"   저장 완료 -> {out_path}")

    print(f"\n완료! {len(saved_paths)}장 저장됨: {out_dir.resolve()}")


if __name__ == "__main__":
    main()

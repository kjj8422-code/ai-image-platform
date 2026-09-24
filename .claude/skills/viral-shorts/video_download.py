"""
video_download.py

영상을 링크로 받아 둔다. (인스타 릴스·게시물, 유튜브, 틱톡 등)
허락 기록은 사용자가 따로 관리한다 — 이 도구는 받기만 한다.

    python video_download.py                          # 링크를 물어보며 받기 (영상받기.bat과 같음)
    python video_download.py https://www.instagram.com/reel/XXXX/ --browser firefox

받은 영상은 out/reference/<날짜>/에 저장되고, 옆에 같은 이름의 .json에 원작자와 원래
주소를 남긴다. 이 파일을 영상으로쇼츠.bat(clip_shorts.py)에 넣으면 원작자 표시가
자동으로 채워진다.

인스타는 로그인해야 보이는 영상이 많다. 그럴 땐 PC 브라우저에 인스타 로그인을 해 둔
뒤 --browser firefox(또는 edge, chrome)를 주면 그 로그인 정보를 빌려 쓴다. 크롬은 켜져
있으면 읽지 못하는 경우가 많아 파이어폭스가 가장 잘 된다.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

SKILL_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SKILL_DIR.parents[2]
REFERENCE_DIR = PROJECT_ROOT / "out" / "reference"
BROWSERS = ("firefox", "edge", "chrome", "whale")

URL_PATTERN = re.compile(r"https?://\S+")


# ---------------------------------------------------------------------------
# 순수 로직 (테스트 대상)
# ---------------------------------------------------------------------------

def extract_urls(text: str) -> list[str]:
    """붙여 넣은 글에서 링크만 뽑는다. 인스타 공유 링크 끝의 ?igsh=... 같은 추적
    꼬리는 떼고, 같은 링크는 한 번만 받는다."""
    urls = []
    for raw in URL_PATTERN.findall(text):
        url = raw.rstrip(").,>\"'")
        if "instagram.com" in url:
            url = url.split("?")[0]
        if url not in urls:
            urls.append(url)
    return urls


def credit_from_info(info: dict) -> str:
    """원작자 표시용 이름. 인스타·틱톡은 @아이디, 그 외엔 채널 이름."""
    handle = info.get("channel") or info.get("uploader_id") or ""
    name = info.get("uploader") or ""
    extractor = (info.get("extractor_key") or "").lower()
    if handle and ("instagram" in extractor or "tiktok" in extractor):
        return handle if handle.startswith("@") else f"@{handle}"
    return name or handle


def safe_name(text: str, limit: int = 40) -> str:
    """파일 이름에 못 쓰는 글자(윈도우 기준)를 지운다."""
    cleaned = re.sub(r'[\\/:*?"<>|\s]+', "_", text).strip("._")
    return (cleaned or "video")[:limit]


def sidecar_path(video: Path) -> Path:
    return video.with_suffix(".json")


def read_sidecar(video: Path) -> dict:
    """영상 옆의 기록(.json)을 읽는다. 없거나 깨졌으면 빈 dict."""
    try:
        return json.loads(sidecar_path(video).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# ---------------------------------------------------------------------------
# 다운로드
# ---------------------------------------------------------------------------

def _ffmpeg_location() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def _upgrade_ytdlp() -> None:
    """인스타가 구조를 바꾸면 yt-dlp 옛 버전은 바로 막힌다. 한 번 최신으로 올린다."""
    print("   다운로드 도구를 최신 버전으로 올리는 중...")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "-U", "--disable-pip-version-check", "yt-dlp"],
        check=False,
    )


# 업데이트로 해결될 리 없는 실패(삭제된 영상, 로그인 필요, 잘못된 링크)는 업데이트를
# 건너뛴다. 그 밖의 실패는 대개 인스타가 구조를 바꾼 것이라 최신 버전이 해결한다.
_NOT_FIXED_BY_UPDATE = ("404", "not available", "login", "private", "unsupported url", "cookies", "decrypt", "database is locked")


def should_upgrade(message: str) -> bool:
    lower = message.lower()
    return not any(key in lower for key in _NOT_FIXED_BY_UPDATE)


class _QuietLogger:
    """yt-dlp가 콘솔에 영어 오류를 직접 찍지 않게 한다. 오류는 예외로 받아 우리말로 바꿔 보여 준다."""

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass


def _friendly_error(message: str) -> str:
    lower = message.lower()
    if "login" in lower or "rate-limit" in lower or "cookies" in lower or "private" in lower:
        return (
            "로그인해야 볼 수 있는 영상이에요. PC 파이어폭스(또는 엣지·크롬)에서 인스타에 "
            "로그인한 뒤, 브라우저를 고르고 다시 받아 주세요."
        )
    if "could not copy" in lower or "database is locked" in lower or "decrypt" in lower:
        return "브라우저 로그인 정보를 읽지 못했어요. 그 브라우저를 모두 닫고 다시 시도하거나 파이어폭스를 써 보세요."
    if "unsupported url" in lower:
        return "지원하지 않는 링크예요. 영상 게시물 주소(예: instagram.com/reel/...)인지 확인해 주세요."
    if "http error 404" in lower or "not available" in lower:
        return "영상이 삭제됐거나 비공개로 바뀌었어요."
    return message.strip().splitlines()[-1] if message.strip() else "알 수 없는 오류"


def download(
    url: str,
    browser: str | None = None,
    out_dir: Path | None = None,
    allow_upgrade: bool = True,
) -> Path:
    """링크 하나를 받아 mp4 경로를 돌려준다. 실패하면 한국어 설명을 담은 RuntimeError."""
    import yt_dlp

    out_dir = out_dir or REFERENCE_DIR / dt.date.today().strftime("%Y%m%d")
    out_dir.mkdir(parents=True, exist_ok=True)
    options = {
        # 원작자 아이디_영상번호.mp4 (원작자를 모르면 video_영상번호.mp4)
        "outtmpl": str(out_dir / "%(uploader_id,uploader,channel|video)s_%(id)s.%(ext)s"),
        # 쇼츠 편집기가 바로 읽을 수 있게 mp4(H.264+AAC)로 받는다.
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # 진행률 막대는 윈도우 콘솔에서 한 줄로 뭉개져 보여서 끈다.
        "noprogress": True,
        "logger": _QuietLogger(),
        "restrictfilenames": False,
        "windowsfilenames": True,
    }
    ffmpeg = _ffmpeg_location()
    if ffmpeg:
        options["ffmpeg_location"] = ffmpeg
    if browser:
        options["cookiesfrombrowser"] = (browser,)

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            if info.get("_type") == "playlist" and info.get("entries"):
                info = next(e for e in info["entries"] if e)  # 게시물 안의 첫 영상
            path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
            if not path.exists():  # 합치지 않고 받은 경우 원래 확장자 그대로
                path = Path(ydl.prepare_filename(info))
    except yt_dlp.utils.DownloadError as error:
        if allow_upgrade and should_upgrade(str(error)):
            _upgrade_ytdlp()
            return download(url, browser, out_dir, allow_upgrade=False)
        raise RuntimeError(_friendly_error(str(error))) from error

    record = {
        "url": url,
        "credit": credit_from_info(info),
        "uploader": info.get("uploader") or "",
        "title": (info.get("title") or info.get("description") or "")[:200],
        "platform": info.get("extractor_key") or "",
        "downloaded_at": dt.datetime.now().isoformat(timespec="seconds"),
    }
    sidecar_path(path).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 대화형 실행 (영상받기.bat)
# ---------------------------------------------------------------------------

def ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="영상을 링크로 받는다")
    parser.add_argument("urls", nargs="*", help="영상 링크 (여러 개 가능)")
    parser.add_argument("--browser", choices=BROWSERS, help="로그인 정보를 빌려 올 브라우저")
    args = parser.parse_args()

    urls = extract_urls(" ".join(args.urls))
    if not urls:
        print("받을 영상 링크를 붙여 넣으세요. 여러 개면 한 줄에 하나씩, 다 넣었으면 빈 줄에서 엔터.")
        while True:
            line = ask("  링크 > ")
            if not line:
                break
            urls += [u for u in extract_urls(line) if u not in urls]
    if not urls:
        print("\n링크가 없어서 끝낼게요.")
        return 0

    browser = args.browser
    if browser is None and any("instagram.com" in u for u in urls):
        print("인스타는 로그인해야 받을 수 있는 영상이 많아요. 인스타에 로그인된 브라우저를 골라 주세요.")
        print("   1) 파이어폭스 (추천)  2) 엣지  3) 크롬  4) 웨일  0) 로그인 없이 시도")
        browser = {"1": "firefox", "2": "edge", "3": "chrome", "4": "whale"}.get(ask("번호 > "))

    ok = 0
    for i, url in enumerate(urls, 1):
        print(f"\n[{i}/{len(urls)}] {url}")
        print("   받는 중...")
        try:
            path = download(url, browser)
        except RuntimeError as error:
            print(f"   [!] 못 받았어요: {error}")
            continue
        credit = read_sidecar(path).get("credit") or "-"
        print(f"   ✔ 저장: {path}")
        print(f"     원작자: {credit}")
        ok += 1

    print(f"\n{ok}/{len(urls)}개 받았어요. 폴더: {REFERENCE_DIR}")
    if ok:
        print("받은 영상을 영상으로쇼츠.bat에 끌어다 놓으면 원작자 표시가 자동으로 들어가요.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

"""
ensure_deps.py

PC에서 쇼츠 도구를 돌리기 전에 필요한 것이 다 깔려 있는지 보고, 없으면 알아서 깐다.
모든 .bat이 맨 처음에 이걸 부른다. 그래서 새 PC에 저장소를 받았거나, 업데이트로
requirements.txt가 바뀌었어도 사람이 명령어를 칠 일이 없다.

    python ensure_deps.py          # 파이썬 패키지 확인·설치 + .env 준비
    python ensure_deps.py --web    # 위에 더해 웹 개발용 npm 패키지도 (업데이트.bat)

한 번 설치한 뒤에는 requirements.txt 내용이 바뀌지 않는 한 1초 안에 넘어간다.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
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
REQUIREMENTS = SKILL_DIR / "requirements.txt"
# 마지막으로 설치에 성공한 requirements.txt의 지문. 내용이 바뀌면 다시 설치한다.
# 저장소에는 올리지 않는다(PC마다 설치 상태가 다르다).
PY_STAMP = SKILL_DIR / ".installed-requirements"
WEB_STAMP = PROJECT_ROOT / "node_modules" / ".installed-package-lock"
ENV_FILE = SKILL_DIR / ".env"
ENV_EXAMPLE = SKILL_DIR / ".env.example"

MIN_PYTHON = (3, 10)


def fingerprint(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stamp_matches(stamp: Path, source: Path) -> bool:
    try:
        return stamp.read_text(encoding="utf-8").strip() == fingerprint(source)
    except OSError:
        return False


def ensure_python_packages() -> bool:
    if stamp_matches(PY_STAMP, REQUIREMENTS):
        return True
    print("  필요한 프로그램을 설치하는 중이에요... (처음 한 번은 1~3분 걸려요)")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
         "-q", "-r", str(REQUIREMENTS)],
    )
    if result.returncode != 0:
        print(
            "\n  [!] 설치에 실패했어요. 인터넷 연결을 확인하고 다시 실행해 주세요.\n"
            "      계속 실패하면 위에 나온 글씨를 그대로 알려주세요."
        )
        return False
    PY_STAMP.write_text(fingerprint(REQUIREMENTS), encoding="utf-8")
    print("  ✔ 설치 완료")
    return True


def ensure_env_file() -> None:
    """로그인 정보 파일이 없으면 틀을 만들어 두고, 빈 칸이 있으면 알려만 준다.

    값이 없어도 멈추지 않는다 — 효과음 넣기처럼 로그인이 필요 없는 도구도 있다.
    """
    if not ENV_FILE.exists() and ENV_EXAMPLE.exists():
        shutil.copyfile(ENV_EXAMPLE, ENV_FILE)
        print(f"  로그인 정보 파일을 만들었어요: {ENV_FILE}")
    try:
        text = ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        return
    values = {}
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    if not values.get("AI_PLATFORM_EMAIL") or not values.get("AI_PLATFORM_PASSWORD"):
        print(
            "  (참고) .env에 사이트 로그인 이메일·비밀번호가 비어 있어요. 영상 만들기에\n"
            f"         필요하니 메모장으로 열어 채워 주세요: {ENV_FILE}"
        )


def ensure_web_packages() -> bool:
    """웹을 PC에서 직접 띄우는 경우에만 필요하다. npm이 없으면 조용히 넘어간다."""
    lock = PROJECT_ROOT / "package-lock.json"
    npm = shutil.which("npm")
    if not npm or not lock.exists():
        return True
    if (PROJECT_ROOT / "node_modules").exists() and stamp_matches(WEB_STAMP, lock):
        return True
    print("  웹 개발용 패키지를 설치하는 중이에요... (몇 분 걸릴 수 있어요)")
    result = subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=PROJECT_ROOT)
    if result.returncode != 0:
        print("  [!] 웹 패키지 설치에 실패했어요. 쇼츠 도구는 그대로 쓸 수 있어요.")
        return True
    WEB_STAMP.write_text(fingerprint(lock), encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--web", action="store_true", help="npm 패키지도 확인")
    args = parser.parse_args()

    if sys.version_info < MIN_PYTHON:
        print(
            f"  [!] 파이썬 {sys.version.split()[0]}은 너무 옛날 버전이에요. "
            f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]} 이상을 python.org에서 설치해 주세요."
        )
        return 1
    if not ensure_python_packages():
        return 1
    ensure_env_file()
    if args.web:
        ensure_web_packages()
    return 0


if __name__ == "__main__":
    sys.exit(main())

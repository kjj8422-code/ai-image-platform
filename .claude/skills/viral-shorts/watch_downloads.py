#!/usr/bin/env python3
"""다운로드 폴더를 지켜보다가 새 쇼츠 대본이 떨어지면 알아서 영상까지 만든다.

웹에서 [프로젝트 파일 내려받기]를 누르는 것 말고는 사람이 할 일이 없게 하는 게
목적이다. 이 창을 한 번 띄워두면 그다음부터는 브라우저에서 내려받을 때마다
영상이 만들어지고 폴더가 저절로 열린다.

    python watch_downloads.py

멈출 때는 이 창에서 Ctrl+C.
"""

import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# 윈도우 기본 콘솔(cp949)이 못 그리는 문자를 만나도 죽지 않게 한다.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")

SKILL_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SKILL_DIR.parents[2]
BUILDER = SKILL_DIR / "build_shorts.py"
DOWNLOADS = Path.home() / "Downloads"
# 화면마다 파일 이름이 다르다: shorts-project.json(사진 쇼츠),
# shorts-video-project.json(AI 영상 쇼츠), shorts-character-project.json(캐릭터
# 쇼츠). 셋 다 "shorts-...project....json" 꼴이라 이 패턴 하나로 다 잡는다.
PATTERN = "shorts-*project*.json"

POLL_SECONDS = 2
# 브라우저가 파일을 다 쓰기 전에 읽으면 내용이 잘린 채로 실패한다. 크기가 두 번
# 연속 같을 때까지 기다렸다가 시작한다.
SETTLE_CHECKS = 2


def found_files() -> dict[Path, float]:
    try:
        return {p: p.stat().st_mtime for p in DOWNLOADS.glob(PATTERN)}
    except OSError:
        return {}


def wait_until_written(path: Path) -> bool:
    last = -1
    stable = 0
    for _ in range(60):
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if size > 0 and size == last:
            stable += 1
            if stable >= SETTLE_CHECKS:
                return True
        else:
            stable = 0
        last = size
        time.sleep(0.5)
    return False


def render(project: Path) -> None:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = PROJECT_ROOT / "out" / stamp

    print()
    print("=" * 60)
    print(f"  새 대본을 찾았습니다: {project.name}")
    print(f"  만드는 중... (몇 분 걸립니다. 이 창을 닫지 마세요)")
    print("=" * 60)
    print()

    result = subprocess.run(
        [sys.executable, str(BUILDER), "--project", str(project),
         "--out-dir", str(out_dir)],
        cwd=str(PROJECT_ROOT),
    )

    print()
    if result.returncode == 0:
        print("\a", end="")  # 다른 일 하고 있어도 알아채도록 소리로 알린다
        print(">> 완성했습니다. 폴더를 엽니다.")
        if sys.platform == "win32":
            subprocess.run(["explorer", str(out_dir)], check=False)
        else:
            subprocess.run(["xdg-open", str(out_dir)], check=False)
    else:
        print(">> 만드는 중에 문제가 생겼습니다. 위 메시지를 그대로 알려주세요.")
    print()
    print("-" * 60)
    print("  다시 기다리는 중입니다. 웹에서 또 내려받으시면 바로 만듭니다.")
    print("-" * 60)


def main() -> None:
    if not BUILDER.exists():
        sys.exit(f"오류: {BUILDER} 를 찾을 수 없습니다.")
    if not DOWNLOADS.is_dir():
        sys.exit(f"오류: 다운로드 폴더를 찾을 수 없습니다 -> {DOWNLOADS}")

    # 켜기 전부터 있던 파일은 건드리지 않는다. 안 그러면 창을 열자마자 예전 대본으로
    # 영상을 만들기 시작한다.
    seen = found_files()

    print()
    print("=" * 60)
    print("  쇼츠 자동 제작 대기 중")
    print("=" * 60)
    print(f"  지켜보는 곳 : {DOWNLOADS}")
    print(f"  이미 있는 파일 {len(seen)}개는 그냥 둡니다.")
    print()
    print("  이제 웹사이트에서 [프로젝트 파일 내려받기] 를 누르세요.")
    print("  나머지는 알아서 합니다. 멈추려면 Ctrl+C.")
    print("=" * 60)

    try:
        while True:
            time.sleep(POLL_SECONDS)
            current = found_files()
            fresh = [
                p for p, m in current.items()
                if p not in seen or m > seen[p]
            ]
            seen = current
            for project in sorted(fresh, key=lambda p: current[p]):
                if wait_until_written(project):
                    render(project)
                    seen = found_files()
                else:
                    print(f">> {project.name} 을(를) 다 받지 못한 것 같습니다. 건너뜁니다.")
    except KeyboardInterrupt:
        print("\n\n  감시를 멈췄습니다. 창을 닫으셔도 됩니다.\n")


if __name__ == "__main__":
    main()

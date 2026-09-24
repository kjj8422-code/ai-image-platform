"""
import_audio.py

무료 사이트에서 받은 효과음·배경음악을 쇼츠에 쓸 수 있게 "칸"에 넣는다.
받은 파일 이름이 뭐든, 형식이 mp3든 wav든 상관없다. 번호만 고르면 된다.

    python import_audio.py                 # 다운로드 폴더에서 최근 파일을 골라 넣기
    python import_audio.py 받은파일.wav     # 이 파일을 바로 넣기 (bat에 끌어다 놓기와 같음)
    python import_audio.py --list          # 칸마다 뭐가 들어 있는지만 보기

넣은 파일은 assets/user/ 아래에 따로 저장된다. 기본 음원은 건드리지 않으므로
언제든 "빼기"로 원래 소리로 되돌릴 수 있다.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
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
CATALOG_PATH = PROJECT_ROOT / "src" / "lib" / "audioCatalog.json"
BUILTIN_DIRS = {"sfx": SKILL_DIR / "assets" / "sfx", "bgm": SKILL_DIR / "assets" / "bgm"}
USER_DIRS = {
    "sfx": SKILL_DIR / "assets" / "user" / "sfx",
    "bgm": SKILL_DIR / "assets" / "user" / "bgm",
}
SOURCE_LOG = SKILL_DIR / "assets" / "user" / "출처기록.txt"

AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".webm", ".opus"}
RECENT_LIMIT = 15
# 이보다 길면 배경음악일 가능성이 높다. 고르는 순서의 기본값만 바꾸고 강제하진 않는다.
BGM_GUESS_SECONDS = 15
# 효과음은 합성할 때 앞 2초만 쓰지만, 파일은 넉넉히 남겨 두고 너무 긴 것만 자른다.
SFX_KEEP_SECONDS = 10
# 배경음악은 영상 길이에 맞춰 반복되므로 5분이면 충분하다. 파일 크기를 줄인다.
BGM_KEEP_SECONDS = 300
# 기본 음악 4곡의 평균 음량(-9 ~ -20 LUFS)에 맞춘다. 사이트마다 녹음 크기가 달라서
# 그대로 넣으면 어떤 곡은 나레이션을 덮고 어떤 곡은 안 들린다.
BGM_LOUDNESS = "loudnorm=I=-14:TP=-1.5:LRA=11"
# 효과음은 앞에 무음이 붙은 파일이 많다. 그대로 두면 장면 시작에 소리가 안 나고
# 한참 뒤에 나거나(최대 2초만 쓰므로) 아예 안 들린다. 앞쪽 무음만 잘라낸다.
SFX_TRIM_SILENCE = "silenceremove=start_periods=1:start_threshold=-50dB"

KIND_NAME = {"sfx": "효과음", "bgm": "배경음악"}


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit(
            "\n[!] 음원 변환 도구가 없습니다. 아래 명령을 한 번 실행해 주세요.\n"
            "    pip install -r .claude/skills/viral-shorts/requirements.txt\n"
        )


def load_slots() -> dict[str, list[dict]]:
    """효과음/배경음악 칸 목록. 웹 화면과 같은 파일을 읽는다."""
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return {
        "sfx": [
            {"name": e["cue"], "label": e["label"], "group": e["group"]}
            for e in catalog["sfx"]
            if e["cue"] != "none"
        ],
        "bgm": [
            {"name": e["mood"], "label": e["label"], "group": e["group"]}
            for e in catalog["bgm"]
        ],
    }


def slot_state(kind: str, name: str) -> str:
    if (USER_DIRS[kind] / f"{name}.mp3").exists():
        return "직접 넣음"
    if (BUILTIN_DIRS[kind] / f"{name}.mp3").exists():
        return "기본 소리"
    return "비어 있음"


def ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def ask_number(prompt: str, low: int, high: int, default: int | None = None) -> int:
    while True:
        answer = ask(prompt)
        if not answer and default is not None:
            return default
        if answer.isdigit() and low <= int(answer) <= high:
            return int(answer)
        print(f"   {low}~{high} 사이 번호를 입력해 주세요.")


def yes(prompt: str) -> bool:
    return ask(prompt).lower() in {"y", "yes", "ㅛ", "네", "예", "응", "1"}


def duration_of(path: Path) -> float | None:
    """파일 길이(초). ffmpeg가 정보를 출력하는 줄에서 읽는다."""
    result = subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def human_seconds(seconds: float | None) -> str:
    if seconds is None:
        return "길이 모름"
    if seconds < 60:
        return f"{seconds:.1f}초"
    return f"{int(seconds // 60)}분 {int(seconds % 60)}초"


def recent_audio_files() -> list[Path]:
    folders = [Path.home() / "Downloads", Path.home() / "Desktop"]
    found = []
    for folder in folders:
        if folder.is_dir():
            found += [
                p
                for p in folder.iterdir()
                if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
            ]
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return found[:RECENT_LIMIT]


def pick_source() -> Path | None:
    files = recent_audio_files()
    print()
    if files:
        print("  다운로드·바탕화면에서 최근에 받은 소리 파일이에요.")
        for i, path in enumerate(files, 1):
            when = dt.datetime.fromtimestamp(path.stat().st_mtime).strftime("%m/%d %H:%M")
            print(f"   {i:>2}) {path.name}   ({when})")
    else:
        print("  다운로드 폴더에 소리 파일(mp3, wav 등)이 없어요.")
    print("    0) 파일 위치를 직접 입력")
    choice = ask_number("\n  몇 번 파일을 넣을까요? > ", 0, len(files), None if files else 0)
    if choice:
        return files[choice - 1]
    typed = ask("  파일 경로를 붙여넣어 주세요 (파일을 이 창에 끌어다 놓아도 돼요) > ")
    path = Path(typed.strip('"').strip("'"))
    return path if path.is_file() else None


def pick_slot(kind: str, slots: dict[str, list[dict]]) -> dict:
    print(f"\n  어느 {KIND_NAME[kind]} 칸에 넣을까요?")
    group = None
    for i, slot in enumerate(slots[kind], 1):
        if slot["group"] != group:
            group = slot["group"]
            print(f"   [{group}]")
        print(f"   {i:>2}) {slot['label']:<24} - {slot_state(kind, slot['name'])}")
    choice = ask_number("\n  번호 > ", 1, len(slots[kind]))
    return slots[kind][choice - 1]


def preview(path: Path) -> None:
    """윈도우 기본 플레이어로 틀어 준다. 다른 OS에선 조용히 넘어간다."""
    if hasattr(os, "startfile"):
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
        except OSError:
            print("   (미리듣기를 열지 못했어요 — 그냥 넘어갑니다)")


def convert(source: Path, target: Path, kind: str) -> None:
    """어떤 형식이든 합성기가 읽는 mp3로 바꾼다. 효과음은 앞 무음을, 음악은 음량을 맞춘다."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.stem + ".tmp.mp3")
    audio_filter = SFX_TRIM_SILENCE if kind == "sfx" else BGM_LOUDNESS
    keep = SFX_KEEP_SECONDS if kind == "sfx" else BGM_KEEP_SECONDS
    command = [
        ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-vn", "-af", audio_filter, "-t", str(keep),
        "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k",
        str(temp),
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0 or not temp.exists() or temp.stat().st_size == 0:
        temp.unlink(missing_ok=True)
        raise RuntimeError(result.stderr.strip() or "변환 결과가 비어 있어요")
    # 변환이 끝까지 성공한 뒤에만 바꿔 끼운다. 중간에 실패해도 기존 소리는 남는다.
    os.replace(temp, target)


def log_source(kind: str, slot: dict, source: Path, note: str) -> None:
    SOURCE_LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    line = f"{stamp} | {KIND_NAME[kind]} {slot['label']} ({slot['name']}.mp3) | 원본: {source.name} | 출처: {note or '(안 적음)'}\n"
    with SOURCE_LOG.open("a", encoding="utf-8") as f:
        f.write(line)


def add_one(slots: dict[str, list[dict]], source: Path | None) -> None:
    source = source or pick_source()
    if not source or not source.is_file():
        print("\n  [!] 그 파일을 찾지 못했어요.")
        return

    seconds = duration_of(source)
    if seconds is None:
        print(f"\n  [!] '{source.name}'은(는) 소리 파일로 읽히지 않아요. 다른 파일을 골라 주세요.")
        return
    print(f"\n  고른 파일: {source.name}  ({human_seconds(seconds)})")

    guess = 2 if seconds >= BGM_GUESS_SECONDS else 1
    print("\n  무엇으로 쓸까요?")
    print(f"    1) 효과음 (장면이 바뀔 때 짧게 '띠링')" + ("   ← 추천" if guess == 1 else ""))
    print(f"    2) 배경음악 (영상 내내 깔리는 음악)" + ("   ← 추천" if guess == 2 else ""))
    kind = "sfx" if ask_number(f"  번호 (엔터 = {guess}) > ", 1, 2, guess) == 1 else "bgm"

    slot = pick_slot(kind, slots)
    target = USER_DIRS[kind] / f"{slot['name']}.mp3"
    if target.exists() and not yes(f"\n  '{slot['label']}' 칸에 전에 넣은 소리가 있어요. 바꿀까요? (y/n) > "):
        print("  그대로 둘게요.")
        return

    if hasattr(os, "startfile") and yes("\n  넣기 전에 한 번 들어볼까요? (y/n) > "):
        preview(source)
        if not yes("  이 소리로 넣을까요? (y/n) > "):
            print("  넣지 않았어요.")
            return

    print("\n  변환하는 중...")
    try:
        convert(source, target, kind)
    except RuntimeError as error:
        print(f"\n  [!] 변환에 실패했어요: {error}")
        return

    note = ask("  어디서 받았는지 적어 둘까요? 나중에 저작권 확인용이에요 (엔터 = 건너뛰기) > ")
    log_source(kind, slot, source, note)

    print(f"\n  ✔ 넣었어요! 이제 웹에서 {KIND_NAME[kind]} '{slot['label']}'을(를) 고르면 이 소리가 나와요.")
    if kind == "sfx":
        print("    (효과음은 영상에서 앞부분 최대 2초만 쓰이고, 음량은 자동으로 맞춰져요)")


def remove_one(slots: dict[str, list[dict]]) -> None:
    placed = [
        (kind, slot)
        for kind in ("sfx", "bgm")
        for slot in slots[kind]
        if (USER_DIRS[kind] / f"{slot['name']}.mp3").exists()
    ]
    if not placed:
        print("\n  직접 넣은 소리가 아직 없어요.")
        return
    print("\n  직접 넣은 소리")
    for i, (kind, slot) in enumerate(placed, 1):
        print(f"   {i:>2}) {KIND_NAME[kind]} - {slot['label']}")
    print("    0) 취소")
    choice = ask_number("\n  몇 번을 뺄까요? > ", 0, len(placed))
    if not choice:
        return
    kind, slot = placed[choice - 1]
    (USER_DIRS[kind] / f"{slot['name']}.mp3").unlink()
    after = slot_state(kind, slot["name"])
    tail = "원래 기본 소리로 돌아갔어요" if after == "기본 소리" else "이제 빈 칸이에요"
    print(f"\n  ✔ '{slot['label']}'에서 뺐어요. {tail}.")


def show_list(slots: dict[str, list[dict]]) -> None:
    for kind in ("sfx", "bgm"):
        print(f"\n  [{KIND_NAME[kind]}]")
        for slot in slots[kind]:
            print(f"    {slot['label']:<24} - {slot_state(kind, slot['name'])}")
    print("\n  '비어 있음' 음악 칸은 영상에서 비슷한 기본 음악이 대신 나와요.")


def main() -> None:
    parser = argparse.ArgumentParser(description="효과음·배경음악을 쇼츠 칸에 넣는다")
    parser.add_argument("file", nargs="?", help="넣을 소리 파일 (없으면 목록에서 고름)")
    parser.add_argument("--list", action="store_true", help="칸마다 뭐가 들어 있는지만 보기")
    args = parser.parse_args()

    slots = load_slots()
    if args.list:
        show_list(slots)
        return

    if args.file:
        add_one(slots, Path(args.file))
        return

    while True:
        print("\n  ===== 음원 넣기 =====")
        print("    1) 받은 소리 파일 넣기")
        print("    2) 지금 칸마다 뭐가 들어 있는지 보기")
        print("    3) 직접 넣은 소리 빼기 (원래대로)")
        print("    0) 끝내기")
        choice = ask_number("  번호 > ", 0, 3)
        if choice == 0:
            return
        if choice == 1:
            add_one(slots, None)
        elif choice == 2:
            show_list(slots)
        else:
            remove_one(slots)


if __name__ == "__main__":
    main()

"""Resolve explicit web music selections to the user's full local recordings."""
import json
import os
from pathlib import Path


def library_entry(mood: str, project_root: Path):
    if not mood.startswith("library-"):
        return None
    catalog = project_root / "src" / "lib" / "musicLibrary.json"
    tracks = json.loads(catalog.read_text(encoding="utf-8"))
    entry = next((track for track in tracks if track["id"] == mood), None)
    if not entry:
        raise ValueError("선택한 음악을 찾을 수 없습니다. PC 합성기를 최신 버전으로 업데이트하세요.")
    return entry


def resolve_library_track(mood: str, project_root: Path, user_bgm_dir: Path):
    entry = library_entry(mood, project_root)
    if entry is None:
        return None
    filename = entry["filename"]
    if Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise ValueError("잘못된 음악 파일 이름입니다.")
    roots = [Path.home() / "Downloads" / "오디오모음", user_bgm_dir]
    if os.environ.get("SHORTS_MUSIC_DIR"):
        roots.insert(0, Path(os.environ["SHORTS_MUSIC_DIR"]))
    for folder in roots:
        for candidate in (folder / filename, folder / f"{mood}.mp3"):
            if candidate.is_file():
                return candidate
    raise FileNotFoundError(f"선택한 원본 음악이 없습니다: {filename}\nDownloads/오디오모음 폴더에 넣거나 SHORTS_MUSIC_DIR로 음악 폴더를 지정하세요.")

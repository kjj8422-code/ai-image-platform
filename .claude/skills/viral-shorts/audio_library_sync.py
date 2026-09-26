"""Private audio folder synchronizer. Originals are never moved or changed.

--scan works offline; --watch uploads new tracks once a downloaded connection
file has been imported with --connect. A failed upload never marks a file synced.
"""
from __future__ import annotations

import argparse
import csv
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
LIBRARY = ROOT / "assets" / "user" / "library"
DEFAULT_FOLDER = Path.home() / "Downloads" / "오디오모음"
EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}
BASE_URL = "https://ai-image-platform-lilac.vercel.app"


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def protect(data: bytes, decrypt=False) -> bytes:
    """Windows DPAPI binds the connection to the current Windows account."""
    if os.name != "nt":
        raise RuntimeError("자동 연결 저장은 Windows에서 지원합니다.")
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_char))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    result = Blob()
    function = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(result.data)


def import_connection(path: Path):
    config = read_json(path)
    if not isinstance(config, dict) or config.get("baseUrl", "").rstrip("/") != BASE_URL:
        raise ValueError("사이트에서 받은 연결 파일인지 확인해주세요.")
    if not re.fullmatch(r"audio1\.[a-f0-9-]{36}\.[a-f0-9]{64}", config.get("token", "")):
        raise ValueError("연결 파일 형식이 올바르지 않습니다.")
    LIBRARY.mkdir(parents=True, exist_ok=True)
    target = LIBRARY / "connection.dpapi"
    temp = target.with_suffix(".tmp")
    temp.write_bytes(protect(json.dumps(config).encode()))
    temp.replace(target)
    print("연결 저장 완료. 다운로드한 연결 JSON 파일은 이제 삭제해도 됩니다.", flush=True)


def connection():
    path = LIBRARY / "connection.dpapi"
    return json.loads(protect(path.read_bytes(), decrypt=True)) if path.exists() else None


def request_json(config, payload=None):
    request = urllib.request.Request(BASE_URL + "/api/audio/library" + ("?ids=1" if payload is None else ""),
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def classify(title: str, artist: str, energy: float, brightness: float, activity: float):
    """Conservative, editable estimates; never claim an official genre label."""
    text = (title + " " + artist).lower()
    if "anno domini" in text or any(t in text for t in ["make money", "dripped out", "boogie down"]):
        genre = "힙합"
    elif any(t in text for t in ["density & time", "xander jones", "planet zoid", "neon night"]):
        genre = "일렉트로닉"
    elif any(t in text for t in ["porchlight", "gravel", "country", "kuntry", "foggy dew", "a person unknown"]):
        genre = "어쿠스틱"
    elif any(t in text for t in ["televisions", "national sweetheart", "blue deer", "cosplay"]):
        genre = "록" if energy > .09 else "팝"
    elif any(t in text for t in ["clark sims", "blue beat", "lalanne"]):
        genre = "재즈·소울"
    elif any(t in text for t in ["death duel", "majestic", "epic", "cinematic"]):
        genre = "시네마틱"
    else:
        genre = "팝" if energy > .06 else "미분류"
    if any(t in title.lower() for t in ["death", "horror", "dark", "stake out", "survival"]):
        mood = "긴장·어두움"
    elif any(t in title.lower() for t in ["dream", "nebula", "pulsar", "intergalactic", "laniakea", "twinkle", "red shift", "event horizon"]):
        mood = "몽환·신비"
    elif any(t in title.lower() for t in ["love", "yours", "tears", "hymn", "heart", "sunset", "lost myself", "gone away"]):
        mood = "감성·따뜻"
    elif any(t in title.lower() for t in ["happy", "boogie", "glitter", "toys", "summer", "stroll", "cruise"]):
        mood = "밝음·경쾌"
    elif any(t in title.lower() for t in ["fearless", "fire", "f16", "legend", "at all costs"]):
        mood = "웅장·강렬"
    elif any(t in title.lower() for t in ["whisper", "presence", "mirrors", "porchlight", "willow"]):
        mood = "차분·편안"
    elif energy > .32 and activity > .18 and brightness > 2200:
        mood = "웅장·강렬"
    elif brightness > 1800 and activity > .09:
        mood = "밝음·경쾌"
    elif energy < .13:
        mood = "차분·편안"
    else:
        mood = "감성·따뜻" if brightness < 1500 else "밝음·경쾌"
    return genre, mood


def analyze(path: Path, track_id: str):
    import imageio_ffmpeg
    import numpy as np
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    # Sample the body, not just silence in the opening. Decode errors are fatal.
    info = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-t", "0", "-f", "null", "-"], capture_output=True, check=True)
    text = info.stderr.decode("utf-8", errors="replace")
    duration_match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", text)
    if not duration_match:
        raise ValueError("재생 시간을 확인할 수 없습니다.")
    h, m, s = map(float, duration_match.groups())
    duration = h * 3600 + m * 60 + s
    if not 0 < duration <= 7200:
        raise ValueError("2시간 이내의 음원만 지원합니다.")
    decoded = subprocess.run([ffmpeg, "-v", "error", "-ss", str(min(15, duration / 4)), "-i", str(path), "-t", "45", "-f", "f32le", "-ac", "1", "-ar", "12000", "pipe:1"], capture_output=True, check=True)
    samples = np.frombuffer(decoded.stdout, dtype="<f4")
    if len(samples) < 1200 or not np.isfinite(samples).all():
        raise ValueError("오디오를 분석하지 못했습니다.")
    rms = float(np.sqrt(np.mean(samples ** 2)))
    frames = samples[:len(samples) // 1024 * 1024].reshape(-1, 1024)
    spectra = np.abs(np.fft.rfft(frames * np.hanning(1024), axis=1))
    brightness = float((spectra * np.fft.rfftfreq(1024, 1 / 12000)).sum() / max(spectra.sum(), 1e-9))
    envelope = np.sqrt(np.mean(frames ** 2, axis=1))
    activity = float(np.abs(np.diff(envelope)).mean() / max(float(envelope.mean()), 1e-9))
    title, separator, artist = path.stem.partition(" - ")
    genre, mood = classify(title, artist, rms, brightness, activity)
    kind = "sfx" if duration < 12 else "bgm"
    if kind == "sfx":
        genre = "환경음·효과음"
    return dict(id=track_id, title=title[:200], artist=artist[:200], genre=genre, mood=mood,
                kind=kind, duration=round(duration, 2), classification="estimated", attribution="")


def compressed(path: Path, track_id: str) -> Path:
    import imageio_ffmpeg
    target = LIBRARY / "cache" / (track_id + ".mp3")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        temp = target.with_suffix(".tmp.mp3")
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-nostdin", "-y", "-i", str(path), "-vn", "-map_metadata", "-1", "-ac", "2", "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "96k", str(temp)], capture_output=True, check=True)
        if temp.stat().st_size > 50 * 1024 * 1024:
            temp.unlink()
            raise ValueError("변환 파일이 50MB를 초과했습니다.")
        temp.replace(target)
    return target


def export_groups(state, destination=None):
    groups = destination or LIBRARY / "분류목록"
    groups.mkdir(parents=True, exist_ok=True)
    tracks = state["tracks"]
    with (groups / "음원분류.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["곡명", "아티스트", "장르(추정)", "분위기(추정)", "길이(초)", "원본"])
        for record in tracks.values():
            t = record["track"]
            writer.writerow([t["title"], t["artist"], t["genre"], t["mood"], t["duration"], record["path"]])
    for field in ["genre", "mood"]:
        labels = {record["track"][field] for record in tracks.values()}
        for label in labels:
            content = "#EXTM3U\n" + "\n".join(record["path"] for record in tracks.values() if record["track"][field] == label) + "\n"
            (groups / f"{field}-{label}.m3u8").write_text(content, encoding="utf-8")


def scan(folder: Path, upload=False):
    if not folder.is_dir():
        raise ValueError(f"음원 폴더를 찾을 수 없습니다: {folder}")
    state_path = LIBRARY / "catalog.json"
    state = read_json(state_path, {"files": {}, "tracks": {}})
    config = connection() if upload else None
    remote = set(request_json(config)["ids"]) if config else set()
    failures = 0
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
            continue
        stat = path.stat()
        # Ignore files that are still downloading/copying. Watch mode retries later.
        if stat.st_size == 0 or time.time() - stat.st_mtime < 15:
            continue
        key = str(path.resolve())
        fingerprint = [stat.st_size, stat.st_mtime_ns]
        known = state["files"].get(key)
        try:
            if not known or known["fingerprint"] != fingerprint or state["tracks"].get(known["id"], {}).get("version") != 2:
                with path.open("rb") as handle:
                    track_id = hashlib.file_digest(handle, "sha256").hexdigest()
                after = path.stat()
                if [after.st_size, after.st_mtime_ns] != fingerprint:
                    continue
                if track_id not in state["tracks"] or state["tracks"][track_id].get("version") != 2:
                    track = analyze(path, track_id)
                    state["tracks"][track_id] = {"path": key, "track": track, "version": 2}
                    print(f"분류: {track['title']} → {track['genre']} / {track['mood']}", flush=True)
                elif not Path(state["tracks"][track_id]["path"]).exists():
                    state["tracks"][track_id]["path"] = key
                known = {"id": track_id, "fingerprint": fingerprint}
                state["files"][key] = known
                write_json(state_path, state)
            track_id = known["id"]
            if config and track_id not in remote:
                media = compressed(path, track_id)
                signed = request_json(config, {"action": "upload", "id": track_id})
                url = signed["url"]
                parsed = urlparse(url)
                if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".supabase.co"):
                    raise ValueError("잘못된 업로드 주소")
                req = urllib.request.Request(url, data=media.read_bytes(), method="PUT", headers={"Content-Type": "audio/mpeg", "x-upsert": "true"})
                with urllib.request.urlopen(req, timeout=180) as response:
                    response.read()
                request_json(config, {"action": "save", "track": state["tracks"][track_id]["track"]})
                remote.add(track_id)
                print(f"등록 완료: {path.name}", flush=True)
        except Exception as error:
            failures += 1
            # Never log a signed URL, device token, or server response body.
            print(f"재시도 예정: {path.name} ({type(error).__name__})", flush=True)
    export_groups(state)
    export_groups(state, folder / "분류목록")
    write_json(LIBRARY / "status.json", {"checkedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "tracks": len(state["tracks"]), "remote": len(remote) if config else None, "failures": failures, "connected": bool(config)})
    print(f"분류 {len(state['tracks'])}개 / 사이트 {len(remote) if config else '연결 대기'} / 오류 {failures}개", flush=True)
    return failures


def resolve_local_track(track_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", track_id):
        raise ValueError("잘못된 내 음원 번호입니다.")
    state = read_json(LIBRARY / "catalog.json", {"tracks": {}})
    record = state["tracks"].get(track_id)
    if not record or not Path(record["path"]).is_file():
        raise FileNotFoundError("선택한 음원이 이 PC에 없습니다. 음원-자동동기화를 실행한 후 다시 제작해주세요.")
    path = Path(record["path"])
    with path.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != track_id:
            raise ValueError("선택한 음원 원본이 변경되었습니다. 다시 동기화해주세요.")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=DEFAULT_FOLDER)
    parser.add_argument("--connect", type=Path)
    parser.add_argument("--scan", action="store_true")
    parser.add_argument("--watch", action="store_true")
    args = parser.parse_args()
    LIBRARY.mkdir(parents=True, exist_ok=True)
    # One process owns this library, including connection import and cache writes.
    lock = (LIBRARY / "sync.lock").open("a+b")
    if os.name == "nt":
        import msvcrt
        lock.seek(0); lock.write(b"0"); lock.flush(); lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            print("음원 동기화가 이미 실행 중입니다.")
            return
    if args.connect:
        import_connection(args.connect)
    while True:
        try:
            failures = scan(args.folder, upload=not args.scan)
            if failures and not args.watch:
                sys.exit(1)
        except Exception as error:
            print(f"동기화 대기: {type(error).__name__}. 연결과 인터넷을 확인해주세요.", flush=True)
            if not args.watch:
                raise
        if not args.watch:
            break
        time.sleep(60)


if __name__ == "__main__":
    main()

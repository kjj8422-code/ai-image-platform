"""
clip_shorts.py

영상 파일 하나를 인기 쇼츠 모양(9:16)으로 바꾼다.

    ┌──────────────┐
    │   훅 제목     │  ← 위: 큰 제목 (+ 원작자 표시)
    │ ░░░░░░░░░░░░ │
    │ ┌──────────┐ │  ← 가운데: 원본 영상을 자르지 않고 통째로
    │ │  원본영상  │ │     (남는 자리는 같은 영상을 흐리게 깔아 채움)
    │ └──────────┘ │
    │   자막 문구   │  ← 아래: 시간에 맞춰 바뀌는 자막
    └──────────────┘

    python clip_shorts.py 영상.mp4                      # 질문에 답하며 만들기 (bat과 같음)
    python clip_shorts.py 영상.mp4 --title "이게 된다고?" --credit @원작자 \
        --captions 자막.txt --bgm playful --start 2 --end 30 --i-have-rights

쓸 수 있는 영상: 직접 찍은 영상, 원작자에게 허락받은 영상, 무료 영상 사이트(Pexels,
Pixabay 등)의 상업 이용 가능 영상, 힉스필드 등으로 만든 영상. 남의 영상을 허락 없이
올리면 저작권 경고(3번이면 채널 삭제)와 파트너 프로그램 거절로 이어지므로, 만들기 전에
권리를 확인하고 출처를 기록한다.

자막 파일(.txt) 형식 — 둘 다 된다:
    3 이게 진짜 된다고?          ← "시작 초 + 문구" (0:03, 00:03.5 도 됨)
    그냥 문구만 한 줄씩          ← 시간이 없으면 영상 길이에 고르게 나눈다
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
import tempfile
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))

import build_shorts as bs  # noqa: E402  (글꼴·줄바꿈·배경음악 찾기를 같이 쓴다)

W, H = bs.VIDEO_WIDTH, bs.VIDEO_HEIGHT
OUT_DIR = bs.PROJECT_ROOT / "out" / "clips"
SOURCE_LOG = SKILL_DIR / "assets" / "user" / "영상출처기록.txt"

TITLE_Y = 120
TITLE_SIZE = 92
TITLE_MAX_LINES = 2
CREDIT_SIZE = 36
CAPTION_Y = int(H * 0.72)
CAPTION_SIZE = 76
CAPTION_MAX_LINES = 2
TEXT_WIDTH = int(W * 0.84)
# 쇼츠는 3분까지 올릴 수 있지만, 길면 끝까지 보는 비율이 뚝 떨어진다.
MAX_SECONDS = 180
LONG_WARNING_SECONDS = 60
# 원본 소리 밑에 까는 배경음악 크기. 원본 말소리를 가리지 않게 build_shorts보다 조금 더 낮춘다.
BGM_UNDER_ORIGINAL = 10 ** (-20 / 20)

TIME_PREFIX = re.compile(r"^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s+(.+)$")


# ---------------------------------------------------------------------------
# 순수 로직 (테스트 대상)
# ---------------------------------------------------------------------------

def parse_captions(text: str, duration: float) -> list[dict]:
    """자막 글을 [{start, end, text}]로 바꾼다. 시간이 붙은 줄은 그 시간에, 안 붙은
    줄만 있으면 영상 길이에 고르게 나눈다. 각 자막은 다음 자막 직전까지 떠 있다."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return []

    timed = []
    for line in lines:
        match = TIME_PREFIX.match(line)
        if not match:
            timed = []
            break
        minutes, seconds, caption = match.groups()
        timed.append((int(minutes or 0) * 60 + float(seconds), caption.strip()))

    if timed:
        timed = sorted((t, c) for t, c in timed if t < duration)
    else:
        step = duration / len(lines)
        timed = [(round(i * step, 3), line) for i, line in enumerate(lines)]

    captions = []
    for i, (start, caption) in enumerate(timed):
        end = timed[i + 1][0] if i + 1 < len(timed) else duration
        if end - start > 0.05:
            captions.append({"start": start, "end": end, "text": caption})
    return captions


def clip_window(total: float, start: float, end: float | None) -> tuple[float, float]:
    """잘라 쓸 구간(시작, 길이). 영상 밖이나 3분 넘는 구간은 안쪽으로 맞춘다."""
    start = min(max(start, 0.0), max(total - 0.5, 0.0))
    stop = total if end is None else min(max(end, start + 0.5), total)
    return start, min(stop - start, MAX_SECONDS)


def build_filter(
    overlays: list[dict], has_audio: bool, bgm_index: int | None, duration: float
) -> tuple[str, str, str | None]:
    """ffmpeg filter_complex 문자열과 출력 라벨(영상, 소리)을 만든다.

    overlays: [{"index": 입력 번호, "x": "(W-w)/2", "y": 120, "start": s, "end": e}]
    입력 0번은 원본 영상, bgm_index는 배경음악 입력 번호(없으면 None).
    """
    parts = [
        # 배경: 화면을 꽉 채우게 확대해서 흐리고 어둡게 — 검은 띠보다 덜 허전하다
        f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
        "boxblur=30:2,eq=brightness=-0.12[bg]",
        # 앞: 원본을 자르지 않고 화면 안에 들어오게 줄인다
        f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease[fg]",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]",
    ]
    label = "v0"
    for n, item in enumerate(overlays, 1):
        out = f"v{n}"
        parts.append(
            f"[{label}][{item['index']}:v]overlay={item['x']}:{item['y']}:"
            f"enable='between(t,{item['start']:.3f},{item['end']:.3f})'[{out}]"
        )
        label = out
    parts.append(f"[{label}]fps=30,format=yuv420p[vout]")

    audio = None
    if has_audio and bgm_index is not None:
        parts.append(f"[{bgm_index}:a]volume={BGM_UNDER_ORIGINAL:.4f}[bgm]")
        parts.append("[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]")
        audio = "aout"
    elif bgm_index is not None:
        parts.append(f"[{bgm_index}:a]volume={bs.BGM_GAIN * 2:.4f},atrim=0:{duration:.3f}[aout]")
        audio = "aout"
    elif has_audio:
        audio = "0:a"
    return ";".join(parts), "vout", audio


def wrap_words(text: str, fits) -> list[str]:
    """띄어쓰기 단위로 줄을 나눈다("이 장/면"처럼 단어 중간에서 끊기지 않게).
    한 단어가 혼자서도 폭을 넘을 때만 글자 단위로 자른다. fits(문자열) -> 폭 안에 들어가는지."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if fits(trial):
            current = trial
            continue
        if current:
            lines.append(current)
        current = ""
        for char in word:  # 너무 긴 단어 하나
            if fits(current + char) or not current:
                current += char
            else:
                lines.append(current)
                current = char
    if current:
        lines.append(current)
    return balance_two_lines(text, lines, fits)


def balance_two_lines(text: str, lines: list[str], fits, width=len) -> list[str]:
    """두 줄로 나뉘면 두 줄 길이가 비슷해지는 곳에서 끊는다.
    ("해외에서 난리난 이 / 장면" 보다 "해외에서 난리난 / 이 장면"이 훨씬 잘 읽힌다)"""
    words = text.split()
    if len(lines) != 2 or len(words) < 2:
        return lines
    best = lines
    best_score = max(width(line) for line in lines)
    for i in range(1, len(words)):
        first, second = " ".join(words[:i]), " ".join(words[i:])
        if fits(first) and fits(second):
            score = max(width(first), width(second))
            if score <= best_score:  # 같으면 윗줄이 긴 쪽(뒤쪽 끊는 자리)을 고른다
                best, best_score = [first, second], score
    return best


# ---------------------------------------------------------------------------
# 글자 그림 (PIL)
# ---------------------------------------------------------------------------

def _text_png(
    text: str, dest: Path, size: int, color: str, stroke: int, max_lines: int
) -> Path:
    """테두리 있는 한글 글자를 투명 PNG로 그린다. 폭을 넘으면 줄을 나누고, 줄이
    너무 많으면 글자를 줄인다."""
    from PIL import Image, ImageDraw, ImageFont

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    while True:
        font = ImageFont.truetype(str(bs.FONT_PATH), size)
        lines = wrap_words(
            text.strip(), lambda s: probe.textlength(s, font=font) <= TEXT_WIDTH
        )
        if len(lines) <= max_lines or size <= 40:
            break
        size -= 6
    lines = lines[:max_lines]
    line_h = int(size * 1.25)
    image = Image.new("RGBA", (W, line_h * len(lines) + stroke * 4), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        x = (W - draw.textlength(line, font=font)) / 2
        draw.text(
            (x, stroke * 2 + i * line_h),
            line,
            font=font,
            fill=color,
            stroke_width=stroke,
            stroke_fill="black",
        )
    image.save(dest)
    return dest


# ---------------------------------------------------------------------------
# ffmpeg
# ---------------------------------------------------------------------------

def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def probe(path: Path) -> tuple[float, bool]:
    """(길이 초, 소리 트랙 유무)."""
    result = subprocess.run(
        [_ffmpeg(), "-hide_banner", "-i", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise ValueError(f"'{path.name}'은(는) 영상으로 읽히지 않아요.")
    h, m, s = match.groups()
    return int(h) * 3600 + int(m) * 60 + float(s), " Audio:" in result.stderr


def make_clip_short(
    source: Path,
    title: str = "",
    credit: str = "",
    captions_text: str = "",
    bgm: str = "",
    start: float = 0.0,
    end: float | None = None,
    out_path: Path | None = None,
) -> Path:
    total, has_audio = probe(source)
    start, duration = clip_window(total, start, end)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = out_path or OUT_DIR / f"{stamp}-{bs.slugify(title or source.stem)}.mp4"

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        inputs = ["-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(source)]
        overlays: list[dict] = []

        def add_png(png: Path, y: int, a: float, b: float) -> None:
            inputs.extend(["-i", str(png)])
            overlays.append(
                {"index": len(overlays) + 1, "x": "(W-w)/2", "y": y, "start": a, "end": b}
            )

        title_bottom = TITLE_Y
        if title.strip():
            png = _text_png(title, tmp / "title.png", TITLE_SIZE, "#FFFFFF", 10, TITLE_MAX_LINES)
            add_png(png, TITLE_Y, 0, duration)
            from PIL import Image

            with Image.open(png) as im:
                title_bottom = TITLE_Y + im.height
        if credit.strip():
            shown = credit.strip() if credit.strip().startswith("영상") else f"영상: {credit.strip()}"
            png = _text_png(shown, tmp / "credit.png", CREDIT_SIZE, "#E4E4E7", 4, 1)
            add_png(png, title_bottom + 8, 0, duration)
        for i, cap in enumerate(parse_captions(captions_text, duration)):
            png = _text_png(cap["text"], tmp / f"cap{i}.png", CAPTION_SIZE, bs.SUBTITLE_COLOR, 9, CAPTION_MAX_LINES)
            add_png(png, CAPTION_Y, cap["start"], cap["end"])

        bgm_index = None
        if bgm:
            bgm_path = bs.find_bgm(bgm)
            if bgm_path:
                inputs.extend(["-stream_loop", "-1", "-i", str(bgm_path)])
                bgm_index = len(overlays) + 1
            else:
                print(f"   (배경음악 '{bgm}'을 찾지 못해서 빼고 만들어요)")

        graph, vout, aout = build_filter(overlays, has_audio, bgm_index, duration)
        command = [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", *inputs,
                   "-filter_complex", graph, "-map", f"[{vout}]"]
        if aout:
            command += ["-map", aout if aout == "0:a" else f"[{aout}]", "-c:a", "aac", "-b:a", "192k"]
        command += ["-t", f"{duration:.3f}", "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "20", "-movflags", "+faststart", str(out_path)]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "영상 합성에 실패했어요.")
    return out_path


# ---------------------------------------------------------------------------
# 대화형 실행 (영상으로쇼츠.bat)
# ---------------------------------------------------------------------------

RIGHTS_OPTIONS = {
    "1": "직접 찍은 영상",
    "2": "원작자에게 허락받은 영상",
    "3": "무료 영상 사이트(상업 이용 가능)",
    "4": "AI로 만든 영상(힉스필드 등)",
}


def ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def log_source(source: Path, rights: str, credit: str, note: str) -> None:
    SOURCE_LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    with SOURCE_LOG.open("a", encoding="utf-8") as f:
        f.write(f"{stamp} | {source.name} | {rights} | 원작자: {credit or '-'} | {note or '-'}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="영상 파일을 인기 쇼츠 모양으로 만든다")
    parser.add_argument("video", nargs="?", help="영상 파일 (bat에 끌어다 놓으면 자동으로 들어감)")
    parser.add_argument("--title", default=None, help="위쪽 훅 제목")
    parser.add_argument("--credit", default=None, help="원작자 표시 (예: @instagram_id)")
    parser.add_argument("--captions", default=None, help="자막 .txt 파일")
    parser.add_argument("--bgm", default=None, help="배경음악 분위기 (playful, epic, ... / 비우면 없음)")
    parser.add_argument("--start", type=float, default=0.0, help="시작 초")
    parser.add_argument("--end", type=float, default=None, help="끝 초")
    parser.add_argument("--i-have-rights", action="store_true", help="이 영상을 쓸 권리를 확인했음")
    args = parser.parse_args()

    interactive = not args.i_have_rights
    video = args.video or ask("영상 파일 경로를 붙여 넣으세요 (파일을 이 창에 끌어다 놓아도 돼요) > ")
    source = Path(video.strip('"').strip("'"))
    if not source.is_file():
        print("\n[!] 그 영상 파일을 찾지 못했어요.")
        return 1

    rights, note = "사용자 확인(--i-have-rights)", ""
    if interactive:
        print("\n이 영상은 어떤 영상인가요? 남의 영상을 허락 없이 올리면 저작권 경고와")
        print("채널 삭제, 파트너 프로그램 거절로 이어져요.")
        for key, label in RIGHTS_OPTIONS.items():
            print(f"   {key}) {label}")
        print("   0) 해당 없음 (만들지 않고 끝내기)")
        choice = ask("번호 > ")
        if choice not in RIGHTS_OPTIONS:
            print("\n만들지 않았어요. 허락받은 영상이나 직접 만든 영상으로 다시 해 주세요.")
            return 0
        rights = RIGHTS_OPTIONS[choice]
        if choice == "2":
            note = ask("허락받은 곳을 적어 두세요 (예: 인스타 DM 2026-09-24) > ")

    credit = args.credit if args.credit is not None else (
        ask("원작자 표시 (예: @아이디, 내 영상이면 엔터) > ") if interactive else ""
    )
    if interactive and rights == RIGHTS_OPTIONS["2"] and not credit:
        credit = ask("허락받은 영상은 원작자 표시가 필요해요. 아이디를 적어 주세요 > ")
    title = args.title if args.title is not None else (ask("위쪽 제목 (예: 이게 된다고?) > ") if interactive else "")

    captions_text = ""
    if args.captions:
        captions_text = Path(args.captions).read_text(encoding="utf-8")
    elif interactive:
        print("자막을 한 줄씩 입력하세요. 앞에 초를 쓰면 그 시간에 나와요 (예: 3 여기서 반전).")
        print("다 쓰면 빈 줄에서 엔터.")
        lines = []
        while True:
            line = ask("  자막 > ")
            if not line:
                break
            lines.append(line)
        captions_text = "\n".join(lines)

    bgm = args.bgm if args.bgm is not None else (
        ask("배경음악 (playful·epic·dreamy·mystery, 없으면 엔터) > ") if interactive else ""
    )

    total, _ = probe(source)
    start, end = args.start, args.end
    if interactive and args.end is None:
        print(f"영상 길이: {total:.1f}초")
        s = ask("몇 초부터 쓸까요? (엔터 = 처음부터) > ")
        e = ask("몇 초까지 쓸까요? (엔터 = 끝까지) > ")
        start = float(s) if s else 0.0
        end = float(e) if e else None
    _, length = clip_window(total, start, end)
    if length > LONG_WARNING_SECONDS:
        print(f"(참고) {length:.0f}초짜리예요. 쇼츠는 60초 안쪽이 끝까지 보는 비율이 높아요.")

    print("\n만드는 중...")
    try:
        out = make_clip_short(source, title, credit, captions_text, bgm, start, end)
    except (RuntimeError, ValueError) as error:
        print(f"\n[!] 만들지 못했어요: {error}")
        return 1
    log_source(source, rights, credit, note)
    print(f"\n✔ 완성! -> {out}")
    print("  업로드할 때 AI 영상이면 '변경되거나 합성된 콘텐츠'를, 허락받은 영상이면 설명란에 원작자를 적어 주세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

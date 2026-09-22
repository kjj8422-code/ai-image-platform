#!/usr/bin/env python3
"""한국어 음성을 전부 들어보고 고르는 도구.

기본 목소리(ko-KR-SunHiNeural)는 안내방송에 맞춰진 톤이라, 썰을 읽히면 아무리
문장부호를 넣어도 밋밋하게 들린다. 목소리를 바꾸는 게 대본을 고치는 것보다 큰
변수인데, 귀로 들어보지 않고는 고를 수가 없어서 샘플을 한 번에 만들어 둔다.

    python voice_lab.py

같은 문장을 쓸 수 있는 한국어 목소리마다 하나씩 만들어 voices/ 에 넣는다.
마음에 드는 걸 고른 뒤 그 이름을 그대로 넘기면 된다.

    python build_shorts.py --project shorts-project.json --voice ko-KR-InJoonNeural

문장을 바꿔 들어보려면:

    python voice_lab.py --text "야 이거 봐봐, 진짜 안 꺼진다니까?"
"""

import argparse
import asyncio
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")

try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

OUT_DIR = Path(__file__).resolve().parent / "voices"
# 억양이 드러나야 비교가 되므로, 감탄사와 물음표·말줄임표가 다 들어간 문장을 쓴다.
SAMPLE = "야 이거 봐봐, 병 안에 해가 들어갔어! 근데 안 꺼짐... 이게 말이 되냐?"
RATE = "+12%"


async def collect() -> list[dict]:
    import edge_tts

    voices = await edge_tts.list_voices()
    korean = [v for v in voices if v.get("Locale", "").startswith("ko-")]
    return sorted(korean, key=lambda v: v["ShortName"])


async def render(voice: str, text: str, dest: Path) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice, rate=RATE)
    await communicate.save(str(dest))


async def main_async(text: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    voices = await collect()
    if not voices:
        sys.exit("한국어 목소리를 찾지 못했습니다. 인터넷 연결을 확인해주세요.")

    print(f"\n한국어 목소리 {len(voices)}개를 찾았습니다. 샘플을 만듭니다.\n")
    print(f'문장: "{text}"\n')

    for voice in voices:
        name = voice["ShortName"]
        gender = "여성" if voice.get("Gender") == "Female" else "남성"
        dest = OUT_DIR / f"{name}.mp3"
        try:
            await render(name, text, dest)
        except Exception as err:
            print(f"  [건너뜀] {name} — {err}")
            continue
        print(f"  {name:28} {gender}  -> {dest.name}")

    print(f"\n샘플 위치: {OUT_DIR}")
    print("\n마음에 드는 목소리를 고른 뒤, 그 이름을 그대로 넘기면 됩니다:")
    print("  python build_shorts.py --project shorts-project.json --voice <목소리이름>\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="한국어 음성 샘플을 한 번에 만들어 비교해 듣는다."
    )
    parser.add_argument("--text", default=SAMPLE, help="들어볼 문장")
    args = parser.parse_args()
    asyncio.run(main_async(args.text))


if __name__ == "__main__":
    main()

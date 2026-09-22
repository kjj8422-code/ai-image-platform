"""build_shorts.py의 순수 로직 검사. `python test_build_shorts.py`로 실행한다.

틀려도 에러가 안 나고 "이상한 영상"으로만 나오는 부분들이라 여기서 잡는다.
프레임워크는 쓰지 않는다 — assert로 충분하다.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

import build_shorts as bs  # noqa: E402


def test_fit_to_frame_makes_exact_9x16():
    """어떤 비율로 들어와도 정확히 1080x1920으로 나와야 한다."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for size in [(900, 1400), (1920, 1080), (1000, 1000), (400, 3000)]:
            src = tmp / f"src_{size[0]}x{size[1]}.png"
            Image.new("RGB", size, (10, 20, 30)).save(src)
            out = bs.fit_to_frame(src, tmp / f"out_{size[0]}x{size[1]}.png")
            with Image.open(out) as img:
                assert img.size == (bs.VIDEO_WIDTH, bs.VIDEO_HEIGHT), (
                    f"{size} -> {img.size}"
                )


def test_fit_to_frame_crops_instead_of_squashing():
    """가로로 긴 사진을 눌러 담으면 인물이 홀쭉해진다. 잘라내야 한다.

    좌우 절반을 다른 색으로 칠한 가로 이미지를 넣으면, 늘린 경우 두 색이 모두
    남지만 가운데를 잘라낸 경우에도 두 색이 남는다. 그래서 세로로 긴 이미지의
    위아래 크롭으로 확인한다 — 위/아래 띠는 사라지고 가운데 색만 남아야 한다.
    """
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        img = Image.new("RGB", (1000, 4000), (0, 255, 0))  # 가운데가 될 초록
        for y in range(0, 500):  # 위쪽 띠
            for x in range(0, 1000, 50):
                img.putpixel((x, y), (255, 0, 0))
        src = tmp / "tall.png"
        img.save(src)

        out = bs.fit_to_frame(src, tmp / "out.png")
        with Image.open(out) as result:
            top = result.getpixel((10, 5))
            assert top == (0, 255, 0), f"위아래를 잘라내지 않았다: {top}"


def test_slugify_never_returns_empty():
    """폴더 이름으로 쓰이므로 절대 빈 문자열이 되면 안 된다."""
    for text in ["", "   ", "???", "!!!...", "///"]:
        assert bs.slugify(text), f"빈 슬러그: {text!r}"


def test_slugify_keeps_korean():
    assert bs.slugify("노루가 날 가둬놨어") == "노루가-날-가둬놨어"


def test_slugify_has_no_trailing_dash_after_truncation():
    """길이 제한으로 잘린 자리에 '-'가 오면 폴더 이름이 '...가가가-'로 끝난다.

    앞뒤 '-'는 자르기 전에만 떼고 있어서, 자른 뒤 다시 생기는 건 못 잡았다.
    """
    text = "가" * 29 + " " + "나" * 10  # 30번째 글자가 정확히 '-'가 되는 입력
    slug = bs.slugify(text)
    assert not slug.endswith("-"), f"끝이 '-': {slug!r}"
    assert len(slug) <= 30


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  OK   {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} 통과")
    sys.exit(1 if failed else 0)

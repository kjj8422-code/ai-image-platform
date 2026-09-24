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


def test_sfx_never_outlasts_its_scene():
    """효과음이 장면보다 길면 다음 장면 대사 위로 넘어간다."""
    assert bs.sfx_length(clip_duration=17.3, scene_duration=3.0) <= 3.0


def test_sfx_is_capped_even_in_a_long_scene():
    """받아온 음원이 17초·19초짜리였다. 장면이 길어도 큐는 짧게 끊어야 한다.

    안 자르면 트레일러 붐 하나가 영상 내내 깔려 나레이션을 덮는다.
    """
    assert bs.sfx_length(clip_duration=17.3, scene_duration=30.0) == bs.SFX_MAX_SECONDS


def test_short_sfx_is_left_alone():
    """0.7초짜리 뽁 소리까지 늘리거나 줄이면 안 된다."""
    assert bs.sfx_length(clip_duration=0.67, scene_duration=4.0) == 0.67


def test_loud_sfx_is_pulled_down_under_the_voice():
    """트레일러 붐(RMS 0.45)은 나레이션(0.106)보다 커서 훅 대사를 덮었다."""
    gain = bs.sfx_gain(0.45325)
    assert 0.45325 * gain < 0.106, "효과음이 여전히 나레이션보다 크다"


def test_quiet_sfx_is_lifted_but_not_blown_up():
    """UI 핑처럼 조용한 파일은 키워야 들리지만, 무한정 키우면 잡음까지 커진다."""
    assert bs.sfx_gain(0.0001) == bs.SFX_MAX_GAIN


def test_silent_file_does_not_crash():
    """빈 파일이 들어와도 0으로 나누면 안 된다."""
    assert bs.sfx_gain(0.0) == 1.0


def test_all_cues_land_at_a_similar_level():
    """파일마다 녹음 레벨이 달라도 귀에는 비슷하게 들려야 한다."""
    levels = [raw * bs.sfx_gain(raw) for raw in (0.45325, 0.05, 0.012)]
    assert max(levels) - min(levels) < 0.01, f"레벨이 제각각이다: {levels}"


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


def _with_audio_dirs(tmp: Path):
    """기본/직접 넣은 음원 폴더를 임시 폴더로 바꿔 끼운다. 원래 값을 돌려준다."""
    saved = (bs.SFX_DIR, bs.BGM_DIR, bs.USER_SFX_DIR, bs.USER_BGM_DIR)
    bs.SFX_DIR, bs.BGM_DIR = tmp / "sfx", tmp / "bgm"
    bs.USER_SFX_DIR, bs.USER_BGM_DIR = tmp / "user" / "sfx", tmp / "user" / "bgm"
    for folder in (bs.SFX_DIR, bs.BGM_DIR, bs.USER_SFX_DIR, bs.USER_BGM_DIR):
        folder.mkdir(parents=True)
    return saved


def _restore_audio_dirs(saved) -> None:
    bs.SFX_DIR, bs.BGM_DIR, bs.USER_SFX_DIR, bs.USER_BGM_DIR = saved


def test_user_sound_wins_over_builtin():
    """음원넣기로 넣은 소리가 있으면 기본 소리 대신 그걸 써야 한다."""
    with tempfile.TemporaryDirectory() as tmp:
        saved = _with_audio_dirs(Path(tmp))
        try:
            (bs.SFX_DIR / "pop.mp3").write_bytes(b"x")
            assert bs.find_sfx("pop") == bs.SFX_DIR / "pop.mp3"
            (bs.USER_SFX_DIR / "pop.mp3").write_bytes(b"x")
            assert bs.find_sfx("pop") == bs.USER_SFX_DIR / "pop.mp3"
            assert bs.find_sfx("my1") is None
        finally:
            _restore_audio_dirs(saved)


def test_empty_music_slot_falls_back_to_similar_builtin():
    """'공포' 칸이 비어 있으면 음악이 빠지는 대신 미스터리 곡이 나와야 한다."""
    with tempfile.TemporaryDirectory() as tmp:
        saved = _with_audio_dirs(Path(tmp))
        try:
            (bs.BGM_DIR / "mystery.mp3").write_bytes(b"x")
            assert bs.find_bgm("horror") == bs.BGM_DIR / "mystery.mp3"
            (bs.USER_BGM_DIR / "horror.mp3").write_bytes(b"x")
            assert bs.find_bgm("horror") == bs.USER_BGM_DIR / "horror.mp3"
        finally:
            _restore_audio_dirs(saved)


def test_new_moods_borrow_title_and_voice_style():
    """새 분위기도 제목 색·목소리 톤이 기본값으로 뭉개지지 않고 비슷한 계열을 따른다."""
    assert bs.mood_family("horror") == "mystery"
    assert bs.mood_family("action") == "epic"
    for entry_mood in bs.BGM_FAMILIES:
        assert bs.mood_family(entry_mood) in bs.TITLE_STYLES, entry_mood
        assert bs.mood_family(entry_mood) in bs.VOICE_STYLES, entry_mood


def test_every_builtin_cue_in_catalog_has_a_file():
    """웹에서 고를 수 있는 기본 효과음은 전부 실제 파일이 있어야 한다."""
    import json

    catalog = json.loads(bs.AUDIO_CATALOG_PATH.read_text(encoding="utf-8"))
    for entry in catalog["sfx"]:
        if entry.get("hint") and entry["cue"] != "none":
            assert (bs.SFX_DIR / f"{entry['cue']}.mp3").exists(), entry["cue"]


def test_contain_keeps_whole_square_product():
    """정사각형 상품 사진의 좌우 끝이 잘리지 않아야 한다(cover였다면 잘려 나간다)."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "product.png"
        image = Image.new("RGB", (1000, 1000), (255, 255, 255))
        # 왼쪽 끝 10%를 빨강으로 칠한다. cover는 가운데만 남겨 이 띠를 잘라낸다.
        for x in range(100):
            for y in range(1000):
                image.putpixel((x, y), (255, 0, 0))
        image.save(src)
        out = bs.fit_to_frame(src, tmp / "out.png", mode="contain")
        with Image.open(out) as frame:
            assert frame.size == (bs.VIDEO_WIDTH, bs.VIDEO_HEIGHT)
            scale = min(bs.CONTAIN_MAX_WIDTH / 1000, bs.CONTAIN_MAX_HEIGHT / 1000)
            left_edge = (bs.VIDEO_WIDTH - int(1000 * scale)) // 2 + 5
            r, g, b = frame.getpixel((left_edge, bs.CONTAIN_CENTER_Y))
            assert r > 200 and g < 60 and b < 60, (r, g, b)


def test_default_fit_is_cover():
    assert bs.image_fit({}, {}) == "cover"
    assert bs.image_fit({"imageFit": "contain"}, {}) == "contain"
    assert bs.image_fit({"imageFit": "contain"}, {"imageFit": "cover"}) == "cover"


def test_review_card_fits_safe_width_and_caps_lines():
    """긴 후기도 카드 폭 안에 들어가고, 세 줄을 넘지 않아 화면을 덮지 않는다."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        short = bs.render_review_card("재구매 세 번째예요", tmp / "a.png", 5)
        long = bs.render_review_card("정말 좋아요 " * 40, tmp / "b.png", 4)
        with Image.open(short) as a, Image.open(long) as b:
            assert a.width == bs.REVIEW_CARD_WIDTH
            assert b.width == bs.REVIEW_CARD_WIDTH
            assert a.height < b.height
            line = int(bs.REVIEW_TEXT_SIZE * 1.35)
            max_height = (
                bs.REVIEW_CARD_PADDING * 2
                + int(bs.REVIEW_LABEL_SIZE * 1.6)
                + line * bs.REVIEW_CARD_MAX_LINES
            )
            assert b.height <= max_height
            # 가장 긴(세 줄) 카드도 상품 영역 위에서 끝나야 상품을 가리지 않는다.
            product_top = bs.CONTAIN_CENTER_Y - bs.CONTAIN_MAX_HEIGHT // 2
            assert bs.REVIEW_CARD_Y + b.height < product_top, (bs.REVIEW_CARD_Y + b.height, product_top)
            # 카드는 좌우 세이프존(각 10%)을 넘지 않는다.
            assert bs.REVIEW_CARD_WIDTH <= bs.VIDEO_WIDTH * 0.8



def test_short_scenes_are_held_and_later_scenes_shift():
    """1초짜리 장면은 최소 시간까지 늘고, 그 뒤 장면은 그만큼 늦게 시작한다."""
    scenes = [
        {"start": 0.0, "duration": 3.0},
        {"start": 3.0, "duration": 1.0},  # "세 시간째." 같은 짧은 대사
        {"start": 4.0, "duration": 2.8},
    ]
    assert bs.hold_short_scenes(scenes, 2.4) is True
    assert [s["duration"] for s in scenes] == [3.0, 2.4, 2.8]
    assert [s["start"] for s in scenes] == [0.0, 3.0, 5.4]
    # 목소리는 원래 구간 그대로 잘라 쓴다
    assert scenes[2]["voice_start"] == 4.0 and scenes[2]["voice_duration"] == 2.8


def test_long_enough_scenes_are_untouched():
    """모든 장면이 충분히 길면 타이밍을 하나도 바꾸지 않는다(목소리도 안 자른다)."""
    scenes = [{"start": 0.0, "duration": 3.0}, {"start": 3.0, "duration": 2.5}]
    assert bs.hold_short_scenes(scenes, 2.4) is False
    assert [(s["start"], s["duration"]) for s in scenes] == [(0.0, 3.0), (3.0, 2.5)]


def test_more_scenes_means_longer_video():
    """장면 수가 늘면 영상도 적어도 장면 수 x 최소 시간만큼 길어진다."""
    for count in (6, 10, 15):
        scenes = [{"start": i * 1.0, "duration": 1.0} for i in range(count)]
        bs.hold_short_scenes(scenes)
        total = scenes[-1]["start"] + scenes[-1]["duration"]
        assert total >= count * bs.MIN_SCENE_SECONDS - 1e-9


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

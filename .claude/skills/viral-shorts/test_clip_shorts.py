"""clip_shorts.py의 순수 로직 검사. `python test_clip_shorts.py`로 실행한다."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import clip_shorts as cs  # noqa: E402


def test_timed_captions_follow_given_seconds():
    caps = cs.parse_captions("0 첫마디\n3.5 둘째\n0:07 셋째", 10)
    assert [(c["start"], c["end"], c["text"]) for c in caps] == [
        (0, 3.5, "첫마디"),
        (3.5, 7, "둘째"),
        (7, 10, "셋째"),
    ]


def test_plain_captions_are_spread_evenly():
    caps = cs.parse_captions("하나\n둘\n셋\n넷", 8)
    assert [c["start"] for c in caps] == [0, 2, 4, 6]
    assert caps[-1]["end"] == 8


def test_captions_after_the_clip_are_dropped():
    caps = cs.parse_captions("1 보임\n30 안 보임", 10)
    assert [c["text"] for c in caps] == ["보임"]


def test_window_is_clamped_and_capped_at_three_minutes():
    assert cs.clip_window(20, 2, 11) == (2, 9)
    assert cs.clip_window(20, -5, 999) == (0, 20)
    assert cs.clip_window(600, 0, None) == (0, cs.MAX_SECONDS)


def test_words_are_not_split_in_the_middle():
    fits = lambda s: len(s) <= 10  # noqa: E731
    # 단어 중간("이 장/면")에서 끊지 않고, 두 줄 길이도 비슷하게 맞춘다
    assert cs.wrap_words("해외에서 난리난 이 장면", fits) == ["해외에서 난리난", "이 장면"]
    # 한 단어가 너무 길 때만 글자로 자른다
    assert cs.wrap_words("가나다라마바사아자차카타", fits) == ["가나다라마바사아자차", "카타"]


def test_filter_mixes_bgm_under_original_sound():
    graph, vout, aout = cs.build_filter(
        [{"index": 1, "x": "(W-w)/2", "y": 120, "start": 0, "end": 5}], True, 2, 5
    )
    assert vout == "vout" and aout == "aout"
    assert "amix=inputs=2" in graph and "[2:a]volume=" in graph
    assert "enable='between(t,0.000,5.000)'" in graph


def test_filter_without_any_audio_has_no_audio_output():
    _, _, aout = cs.build_filter([], False, None, 5)
    assert aout is None


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

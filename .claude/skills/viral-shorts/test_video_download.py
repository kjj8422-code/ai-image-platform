"""video_download.py의 순수 로직 검사. `python test_video_download.py`로 실행한다."""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import video_download as vd  # noqa: E402


def test_urls_are_extracted_and_instagram_tracking_removed():
    text = (
        "이거 봐 https://www.instagram.com/reel/ABC123/?igsh=xyz 그리고\n"
        "https://youtu.be/ax_idP_1XWE?si=abc, https://www.instagram.com/reel/ABC123/"
    )
    assert vd.extract_urls(text) == [
        "https://www.instagram.com/reel/ABC123/",
        "https://youtu.be/ax_idP_1XWE?si=abc",
    ]


def test_credit_uses_handle_for_instagram_and_name_elsewhere():
    assert vd.credit_from_info({"extractor_key": "Instagram", "channel": "cool.creator", "uploader": "Cool"}) == "@cool.creator"
    assert vd.credit_from_info({"extractor_key": "TikTok", "uploader_id": "@already"}) == "@already"
    assert vd.credit_from_info({"extractor_key": "Youtube", "uploader": "Some Channel", "uploader_id": "@some"}) == "Some Channel"


def test_safe_name_removes_windows_forbidden_chars():
    assert vd.safe_name('a/b:c*d?"e<f>g|h i') == "a_b_c_d_e_f_g_h_i"
    assert vd.safe_name("") == "video"


def test_sidecar_round_trip_and_missing_file():
    with tempfile.TemporaryDirectory() as tmp:
        video = Path(tmp) / "creator_123.mp4"
        video.write_bytes(b"")
        assert vd.read_sidecar(video) == {}
        vd.sidecar_path(video).write_text(json.dumps({"credit": "@creator"}), encoding="utf-8")
        assert vd.read_sidecar(video)["credit"] == "@creator"


def test_friendly_error_for_login_required():
    msg = vd._friendly_error("ERROR: [Instagram] ABC: Requested content is not available, rate-limit reached or login required")
    assert "로그인" in msg



def test_update_is_skipped_when_it_cannot_help():
    assert not vd.should_upgrade("HTTP Error 404: File not found")
    assert not vd.should_upgrade("rate-limit reached or login required")
    assert vd.should_upgrade("Unable to extract shared data; please report this issue")


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

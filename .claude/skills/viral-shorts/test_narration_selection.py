"""Offline tests: compile pure helpers without loading media/network dependencies."""
import ast
import json
import unittest
from unittest.mock import Mock
from pathlib import Path

SOURCE = Path(__file__).with_name("build_shorts.py")
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
scope = {
    "Path": Path, "json": json, "DEFAULT_BGM_MOOD": "mystery",
    "DEFAULT_VOICE_STYLE": {"voice": "ko-KR-SunHiNeural", "rate": "+8%", "pitch": "-12Hz"},
    "VOICE_STYLES": {"epic": {"voice": "ko-KR-InJoonNeural", "rate": "+10%", "pitch": "-8Hz"}},
    "mood_family": lambda value: value,
}
helpers = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in
           ("resolve_narration_style", "narration_cache_matches")]
exec(compile(ast.Module(body=helpers, type_ignores=[]), str(SOURCE), "exec"), scope)


class NarrationSelectionTests(unittest.TestCase):
    def test_legacy_and_auto_keep_mood_voice(self):
        resolve = scope["resolve_narration_style"]
        self.assertEqual(resolve({"bgmMood": "epic"})["voice"], "ko-KR-InJoonNeural")
        self.assertEqual(resolve({"narrationVoice": "auto"})["voice"], "ko-KR-SunHiNeural")

    def test_selected_voice_and_cli_precedence(self):
        resolve = scope["resolve_narration_style"]
        project = {"bgmMood": "epic", "narrationVoice": "ko-KR-SunHiNeural"}
        self.assertEqual(resolve(project)["voice"], "ko-KR-SunHiNeural")
        self.assertEqual(resolve(project)["rate"], "+10%")
        self.assertEqual(resolve(project, "override")["voice"], "override")
        self.assertEqual(scope["VOICE_STYLES"]["epic"]["voice"], "ko-KR-InJoonNeural")
        with self.assertRaises(ValueError):
            resolve({"narrationVoice": "unknown"})

    def test_cache_invalidated_by_voice_script_and_style(self):
        matches = scope["narration_cache_matches"]
        expected = {"style": {"voice": "a", "rate": "+8%"}, "narrations": ["hello"]}
        path = Mock(spec=Path)
        path.read_text.side_effect = FileNotFoundError()
        self.assertFalse(matches(path, expected))
        path.read_text.side_effect = None
        path.read_text.return_value = json.dumps(expected)
        self.assertTrue(matches(path, expected))
        for changed in ({"style": {"voice": "b"}, "narrations": ["hello"]},
                        {"style": expected["style"], "narrations": ["changed"]}):
            self.assertFalse(matches(path, changed))
        path.read_text.return_value = "invalid json"
        self.assertFalse(matches(path, expected))


if __name__ == "__main__":
    unittest.main()

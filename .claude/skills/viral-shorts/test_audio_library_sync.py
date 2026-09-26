import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import audio_library_sync as sync


class AudioSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folder = self.root / "audio"
        self.folder.mkdir()
        self.library = self.root / "library"
        self.setting = patch.object(sync, "LIBRARY", self.library)
        self.setting.start()

    def tearDown(self):
        self.setting.stop()
        self.temp.cleanup()

    def add(self, name, data=b"audio"):
        path = self.folder / name
        path.write_bytes(data)
        os.utime(path, (1, 1))
        return path

    @staticmethod
    def metadata(path, track_id):
        return dict(id=track_id, title=path.stem, artist="Test", genre="팝", mood="밝음·경쾌", kind="bgm", duration=60, classification="estimated", attribution="")

    def test_duplicates_unchanged_files_and_new_additions(self):
        original = self.add("original.mp3")
        self.add("copy.mp3")
        with patch.object(sync, "analyze", side_effect=self.metadata) as analyze:
            sync.scan(self.folder)
            sync.scan(self.folder)
            self.assertEqual(analyze.call_count, 1)
            self.add("new.mp3", b"second")
            sync.scan(self.folder)
            self.assertEqual(analyze.call_count, 2)
        state = sync.read_json(self.library / "catalog.json")
        self.assertEqual(len(state["tracks"]), 2)
        self.assertEqual(original.read_bytes(), b"audio")

    def test_incomplete_files_wait_until_stable(self):
        self.add("pending.mp3").touch()
        with patch.object(sync, "analyze") as analyze:
            sync.scan(self.folder)
            analyze.assert_not_called()

    def test_failed_upload_is_retried_and_not_marked_remote(self):
        self.add("song.mp3")
        def remote(config, payload=None):
            if payload is None:
                return {"ids": []}
            raise ConnectionError("offline")
        with patch.object(sync, "analyze", side_effect=self.metadata), patch.object(sync, "connection", return_value={"token": "test"}), patch.object(sync, "request_json", side_effect=remote) as api, patch.object(sync, "compressed", return_value=self.folder / "song.mp3"):
            self.assertEqual(sync.scan(self.folder, upload=True), 1)
            self.assertEqual(sync.scan(self.folder, upload=True), 1)
            self.assertEqual(api.call_count, 4)
        self.assertEqual(sync.read_json(self.library / "status.json")["remote"], 0)

    def test_original_resolution_rejects_tampering_and_path_input(self):
        path = self.add("song.mp3")
        track_id = hashlib.sha256(b"audio").hexdigest()
        with patch.object(sync, "analyze", side_effect=self.metadata):
            sync.scan(self.folder)
        self.assertEqual(sync.resolve_local_track(track_id), path)
        with self.assertRaises(ValueError):
            sync.resolve_local_track("../../secret")
        path.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            sync.resolve_local_track(track_id)

    def test_connection_import_rejects_another_site(self):
        path = self.root / "connection.json"
        path.write_text(json.dumps({"baseUrl": "https://example.com", "token": "bad"}))
        with self.assertRaises(ValueError):
            sync.import_connection(path)

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI")
    def test_saved_device_credentials_are_encrypted(self):
        encrypted = sync.protect(b"audio-test-credential")
        self.assertNotIn(b"audio-test-credential", encrypted)
        self.assertEqual(sync.protect(encrypted, decrypt=True), b"audio-test-credential")


if __name__ == "__main__":
    unittest.main()

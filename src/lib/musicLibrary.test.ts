import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import tracks from "./musicLibrary.json" with { type: "json" };
import { resolvePreviewFile } from "./audioCatalog.ts";

test("every library selection has a unique ID and a real preview", () => {
  assert.equal(tracks.length, 132);
  assert.equal(new Set(tracks.map(t => t.id)).size, tracks.length);
  for (const track of tracks) {
    assert.match(track.id, /^library-[a-f0-9]{12}$/);
    assert.ok(track.duration > 15);
    assert.ok(existsSync(new URL(`../../.claude/skills/viral-shorts/assets/library/${track.id}.mp3`, import.meta.url)));
    assert.deepEqual(resolvePreviewFile("bgm", track.id), { kind: "library", name: track.id, isStandIn: false });
    assert.deepEqual(resolvePreviewFile("library", track.id), resolvePreviewFile("bgm", track.id));
  }
});

test("library preview rejects arbitrary paths and unknown track IDs", () => {
  for (const id of ["../bgm/playful", "library-ffffffffffff", "../../.env"]) assert.equal(resolvePreviewFile("library", id), null);
});

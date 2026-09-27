import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CLIP_BYTES, validClipFile, ownsClipPath } from "./sceneClipUpload.ts";

test("accepts MP4 within the size limit and rejects empty or oversized files", () => {
  assert.equal(validClipFile("clip.MP4", MAX_CLIP_BYTES), true);
  for (const size of [0, -1, MAX_CLIP_BYTES + 1, NaN, 1.5]) assert.equal(validClipFile("clip.mp4", size), false);
  assert.equal(validClipFile("clip.mov", 100), false);
});

test("completion only accepts the authenticated user's exact scene upload path", () => {
  const path = "owner/scene-uploads/scene/12345678-1234-1234-1234-123456789abc.mp4";
  assert.equal(ownsClipPath(path, "owner", "scene"), true);
  assert.equal(ownsClipPath(path, "other", "scene"), false);
  assert.equal(ownsClipPath(path, "owner", "other"), false);
  for (const invalid of [null, "https://example.com/clip.mp4", path + "/../file.mp4", path.replace("12345678-", "../12345678-")]) assert.equal(ownsClipPath(invalid, "owner", "scene"), false);
});

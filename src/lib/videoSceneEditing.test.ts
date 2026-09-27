import assert from "node:assert/strict";
import test from "node:test";
import { moveItem, isExactSceneOrder, composeEditedVisualPrompt, withSceneContinuity, VISUAL_LIMITS } from "./videoSceneEditing.ts";

test("reordering keeps image, visual direction and draft attached to stable scene identity", () => {
  const a = { id: "a", image: "a.jpg", narration: "A", keyAction: "walk" };
  const b = { id: "b", image: "b.jpg", narration: "B", keyAction: "wave" };
  const original = [a,b];
  const draft = { a: "unsaved script" };
  const result = moveItem(original, 0, 1);
  assert.deepEqual(result, [b,a]);
  assert.deepEqual(original, [a,b]);
  assert.equal(draft[result[1].id as "a"], "unsaved script");
  assert.equal(moveItem(original,0,-1), original);
  assert.equal(moveItem(original,1,1), original);
});

test("server order validation rejects duplicate, missing and foreign scenes", () => {
  assert.equal(isExactSceneOrder(["a","b"],["b","a"]),true);
  for (const order of [["a","a"],["a"],["a","x"],null,["a",1]]) {
    assert.equal(isExactSceneOrder(["a","b"],order),false);
  }
});

test("visual instructions never include narration and continuity uses adjacent directions", () => {
  const scene = { keyAction: "Walk right", cameraMotion: "pan right", preserveNotes: "blue coat", narration: "SECRET SCRIPT" };
  const prompt = composeEditedVisualPrompt(scene);
  assert.ok(prompt.includes("Walk right"));
  assert.ok(!prompt.includes("SECRET SCRIPT"));
  const final = withSceneContinuity(prompt, scene, { ...scene, keyAction: "Stop" });
  assert.ok(final.includes("Previous camera: pan right"));
  assert.ok(final.includes("Next action: Stop"));
});

test("provider character budget preserves user's instructions and rejects overlong input", () => {
  const prompt = composeEditedVisualPrompt({keyAction:"가".repeat(VISUAL_LIMITS.keyAction),cameraMotion:"나".repeat(VISUAL_LIMITS.cameraMotion),preserveNotes:"다".repeat(VISUAL_LIMITS.preserveNotes)});
  const final = withSceneContinuity(prompt, {keyAction:"x".repeat(2000), cameraMotion:"pan",preserveNotes:null});
  assert.ok(final.startsWith(prompt));
  assert.ok(final.length <= 1000);
  assert.equal(withSceneContinuity("x".repeat(1000)).length,1000);
  assert.throws(()=>withSceneContinuity("x".repeat(1001)), /너무 깁니다/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { directGeneratedAudio, isAudioBed } from "./audioDirection.ts";

test("generated accents do not repeat on adjacent photos", () => {
  const input = [{ sfx: "shutter" }, { sfx: "shutter" }, { sfx: "success" }] as const;
  const result = directGeneratedAudio([...input]);
  assert.deepEqual(result.map(s => s.sfx), ["shutter", "none", "success"]);
  assert.equal(input[1].sfx, "shutter"); // no mutation
});

test("heavy sounds are capped while intentional silence stays silent", () => {
  const result = directGeneratedAudio([
    { sfx: "boom" }, { sfx: "none" }, { sfx: "impact" }, { sfx: "alarm" },
  ]);
  assert.deepEqual(result.map(s => s.sfx), ["boom", "none", "impact", "none"]);
});

test("environment can continue across photos and always plays as a bed", () => {
  const result = directGeneratedAudio([{ sfx: "waves", sfxTiming: "end" }, { sfx: "waves" }]);
  assert.deepEqual(result.map(s => [s.sfx, s.sfxTiming]), [["waves", "start"], ["waves", "start"]]);
  assert.equal(isAudioBed("rain"), true);
  assert.equal(isAudioBed("shutter"), false);
});

test("AI timing is retained; absent reaction timing defaults to the ending", () => {
  const result = directGeneratedAudio([{ sfx: "ding", sfxTiming: "middle" }, { sfx: "laugh" }]);
  assert.deepEqual(result.map(s => s.sfxTiming), ["middle", "end"]);
});

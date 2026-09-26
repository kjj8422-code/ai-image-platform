import assert from "node:assert/strict";
import test from "node:test";
import { recommendedAudioMood } from "./personalAudio.ts";

test("personal BGM recommendations follow the storyboard direction", () => {
  assert.equal(recommendedAudioMood("horror"), "긴장·어두움");
  assert.equal(recommendedAudioMood("travel"), "밝음·경쾌");
  assert.equal(recommendedAudioMood("documentary"), "차분·편안");
  assert.equal(recommendedAudioMood("romantic"), "감성·따뜻");
  assert.equal(recommendedAudioMood("action"), "웅장·강렬");
  assert.equal(recommendedAudioMood("dreamy"), "몽환·신비");
});

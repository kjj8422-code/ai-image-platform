import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import {
  AI_BGM_MOODS,
  AI_SFX_CUES,
  BGM_ENTRIES,
  BGM_MOODS,
  SFX_ENTRIES,
  SFX_LIBRARY,
  resolvePreviewFile,
} from "./audioCatalog.ts";

// 웹이 고르는 이름과 PC가 찾는 mp3 이름이 어긋나면 에러 없이 "소리가 빠진 영상"만
// 나온다. 그래서 목록끼리, 목록과 실제 파일끼리 맞는지 여기서 본다.

const ASSETS = new URL("../../.claude/skills/viral-shorts/assets/", import.meta.url);

test("JSON의 효과음 이름과 타입용 목록이 정확히 같다", () => {
  assert.deepEqual(
    SFX_ENTRIES.map((e) => e.cue),
    [...SFX_LIBRARY],
  );
});

test("JSON의 배경음악 이름과 타입용 목록이 정확히 같다", () => {
  assert.deepEqual(
    BGM_ENTRIES.map((e) => e.mood),
    [...BGM_MOODS],
  );
});

test("AI가 고를 수 있는 효과음은 전부 실제 mp3가 들어 있다", () => {
  for (const cue of AI_SFX_CUES) {
    if (cue === "none") continue;
    assert.ok(existsSync(new URL(`sfx/${cue}.mp3`, ASSETS)), `sfx/${cue}.mp3 없음`);
  }
});

test("AI가 고를 수 있는 배경음악은 전부 실제 mp3가 들어 있다", () => {
  for (const mood of AI_BGM_MOODS) {
    assert.ok(existsSync(new URL(`bgm/${mood}.mp3`, ASSETS)), `bgm/${mood}.mp3 없음`);
  }
});

test("직접 넣는 음악은 전부 파일이 있는 기본 음악으로 물러설 수 있다", () => {
  const moods = new Set<string>(AI_BGM_MOODS);
  for (const entry of BGM_ENTRIES) {
    assert.ok(moods.has(entry.family), `${entry.mood}의 대체곡 ${entry.family}가 기본 음악이 아님`);
  }
});

test("사람만 고르는 칸(내 효과음 등)은 AI 목록에 없다", () => {
  assert.ok(!(AI_SFX_CUES as readonly string[]).includes("my1"));
  assert.ok(!(AI_BGM_MOODS as readonly string[]).includes("my1"));
  assert.ok((AI_BGM_MOODS as readonly string[]).includes("horror"));
});

test("미리듣기는 목록에 있는 이름만 파일로 바꾼다 (경로 조작 차단)", () => {
  assert.equal(resolvePreviewFile("sfx", "../../../.env"), null);
  assert.equal(resolvePreviewFile("bgm", "..%2F.env"), null);
  assert.equal(resolvePreviewFile("secret", "boom"), null);
});

test("효과음 미리듣기: 기본 소리는 되고, 빈 칸·없음은 안 된다", () => {
  assert.deepEqual(resolvePreviewFile("sfx", "coin"), { kind: "sfx", name: "coin", isStandIn: false });
  assert.equal(resolvePreviewFile("sfx", "my1"), null);
  assert.equal(resolvePreviewFile("sfx", "none"), null);
});

test("배경음악 미리듣기: 빈 칸은 대신 나올 기본 곡을 들려준다", () => {
  assert.deepEqual(resolvePreviewFile("bgm", "my1"), { kind: "bgm", name: "playful", isStandIn: true });
  assert.deepEqual(resolvePreviewFile("bgm", "horror"), { kind: "bgm", name: "horror", isStandIn: false });
  assert.deepEqual(resolvePreviewFile("bgm", "epic"), { kind: "bgm", name: "epic", isStandIn: false });
});

test("미리듣기로 고른 파일은 전부 실제로 있다", () => {
  for (const entry of SFX_ENTRIES) {
    const file = resolvePreviewFile("sfx", entry.cue);
    if (file) assert.ok(existsSync(new URL(`sfx/${file.name}.mp3`, ASSETS)), file.name);
  }
  for (const entry of BGM_ENTRIES) {
    const file = resolvePreviewFile("bgm", entry.mood);
    assert.ok(file && existsSync(new URL(`bgm/${file.name}.mp3`, ASSETS)), entry.mood);
  }
});

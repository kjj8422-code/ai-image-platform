import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SCENES, MIN_SCENES, resolveSceneCount, sceneSecondsRange, takeUsableScenes } from "./shortsFromImages.ts";

// 모델이 사진 번호를 잘못 부르면 영상이 조용히 어긋난다(없는 사진을 가리키거나
// 같은 사진이 두 번 나온다). 에러가 아니라 "이상한 결과"로 나오는 종류라 테스트로 잡는다.

test("고른 순서를 그대로 유지한다", () => {
  const scenes = [{ imageIndex: 3 }, { imageIndex: 1 }, { imageIndex: 2 }];
  assert.deepEqual(takeUsableScenes(scenes, 3), scenes);
});

test("사진 개수를 벗어난 번호는 버린다", () => {
  const scenes = [{ imageIndex: 1 }, { imageIndex: 9 }, { imageIndex: 0 }, { imageIndex: 2 }];
  assert.deepEqual(takeUsableScenes(scenes, 3), [{ imageIndex: 1 }, { imageIndex: 2 }]);
});

test("같은 사진을 두 번 쓰면 뒤엣것을 버린다", () => {
  const scenes = [{ imageIndex: 2 }, { imageIndex: 2 }, { imageIndex: 1 }];
  assert.deepEqual(takeUsableScenes(scenes, 3), [{ imageIndex: 2 }, { imageIndex: 1 }]);
});

test("정수가 아닌 번호는 버린다", () => {
  const scenes = [{ imageIndex: 1.5 }, { imageIndex: 2 }];
  assert.deepEqual(takeUsableScenes(scenes, 3), [{ imageIndex: 2 }]);
});

test(`장면이 아무리 많아도 ${MAX_SCENES}개를 넘기지 않는다`, () => {
  const scenes = Array.from({ length: 12 }, (_, i) => ({ imageIndex: i + 1 }));
  assert.equal(takeUsableScenes(scenes, 12).length, MAX_SCENES);
});

test("장면 수를 직접 정하면 그 수까지 받는다 (기본 8개 상한을 넘어서도)", () => {
  const scenes = Array.from({ length: 12 }, (_, i) => ({ imageIndex: i + 1 }));
  assert.equal(takeUsableScenes(scenes, 12, 10).length, 10);
  assert.equal(takeUsableScenes(scenes, 12).length, MAX_SCENES);
});

test("장면 수는 최소치 이상, 올린 사진 수 이하일 때만 받는다", () => {
  assert.equal(resolveSceneCount(10, 10), 10);
  assert.equal(resolveSceneCount(7, 10), 7);
  assert.equal(resolveSceneCount(11, 10), null); // 사진보다 많을 수 없다
  assert.equal(resolveSceneCount(MIN_SCENES - 1, 10), null);
  assert.equal(resolveSceneCount("10", 10), null);
  assert.equal(resolveSceneCount(undefined, 10), null); // AI가 정하기
});

test("장면이 늘면 목표 영상 길이도 늘어난다 (장면당 3~4.2초)", () => {
  // 6장면은 "AI가 정하기"(18~30초)와 같은 구간이어야 한다 — 직접 골랐다고 짧아지면 안 된다.
  assert.deepEqual(sceneSecondsRange(6), { min: 18, max: 25 });
  assert.deepEqual(sceneSecondsRange(10), { min: 30, max: 42 });
  assert.deepEqual(sceneSecondsRange(15), { min: 45, max: 63 });
});

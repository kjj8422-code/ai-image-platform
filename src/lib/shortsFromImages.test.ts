import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SCENES, takeUsableScenes } from "./shortsFromImages.ts";

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

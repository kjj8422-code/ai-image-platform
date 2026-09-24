import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COUPANG_DISCLOSURE,
  MAX_PRODUCT_SCENES,
  buildDescription,
  buildPinnedComment,
  findFakeExperienceClaims,
  isQuoteFromReviews,
  takeProductScenes,
} from "./productShortsRules.ts";

// 쇼핑 쇼츠에서 틀리면 "법 위반"이 되는 부분들이라, 모델 출력과 무관하게 서버 규칙이
// 제대로 걸러내는지 여기서 본다.

const REVIEWS = `김*수 ★★★★★ 2026.09.01
겨울 출근길에 들고 다니는데 6시간 지나도 따뜻해요.
뚜껑도 안 새서 가방에 넣어도 돼요

이*영 ★★★☆☆
생각보다 무거워요. 그래도 보온은 확실함`;

test("후기 원문에 있는 문장은 인용으로 인정한다", () => {
  assert.ok(isQuoteFromReviews("6시간 지나도 따뜻해요", REVIEWS));
});

test("줄바꿈·따옴표 차이는 지어낸 것으로 보지 않는다", () => {
  assert.ok(isQuoteFromReviews("“따뜻해요. 뚜껑도 안 새서”", REVIEWS));
});

test("원문을 바꿔 쓴 인용은 걸러낸다", () => {
  assert.ok(!isQuoteFromReviews("10시간 지나도 따뜻해요", REVIEWS));
  assert.ok(!isQuoteFromReviews("보온력 최고예요", REVIEWS));
  assert.ok(!isQuoteFromReviews("", REVIEWS));
});

test("진행자가 써 본 척하는 표현을 찾아낸다", () => {
  const found = findFakeExperienceClaims([
    "제가 직접 써봤는데 진짜 따뜻해요",
    "한 달째 쓰는 중인데 멀쩡해요",
    "저도 샀어요!",
    "벌써 3개나 반품했거든요",
    "구매자들이 제일 많이 한 말이 이거예요",
    "6시간 지나도 따뜻하대요",
  ]);
  assert.deepEqual(found, [
    "제가 직접 써봤는데 진짜 따뜻해요",
    "한 달째 쓰는 중인데 멀쩡해요",
    "저도 샀어요!",
    "벌써 3개나 반품했거든요",
  ]);
});

test("사진 번호가 범위 밖인 장면은 버리고, 같은 사진 재사용은 허용한다", () => {
  const scenes = [{ imageIndex: 1 }, { imageIndex: 1 }, { imageIndex: 3 }, { imageIndex: 0 }, { imageIndex: 2 }];
  assert.deepEqual(takeProductScenes(scenes, 2), [{ imageIndex: 1 }, { imageIndex: 1 }, { imageIndex: 2 }]);
});

test("장면이 많아도 최대치에서 자른다", () => {
  const scenes = Array.from({ length: 20 }, () => ({ imageIndex: 1 }));
  assert.equal(takeProductScenes(scenes, 1).length, MAX_PRODUCT_SCENES);
});

test("설명란과 고정 댓글에는 항상 링크 자리와 쿠팡 대가성 문구가 들어간다", () => {
  const withLink = buildDescription("겨울 필수템", ["#보온병", "#쿠팡추천"], "https://link.coupang.com/a/abc");
  assert.ok(withLink.includes("https://link.coupang.com/a/abc"));
  assert.ok(withLink.includes("#보온병 #쿠팡추천"));
  assert.ok(withLink.endsWith(COUPANG_DISCLOSURE));

  const noLink = buildPinnedComment("이거 품절 전에 보세요", "");
  assert.ok(noLink.includes("쿠팡 파트너스 링크"));
  assert.ok(noLink.endsWith(COUPANG_DISCLOSURE));
});

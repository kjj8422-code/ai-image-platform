import assert from "node:assert/strict";
import { test } from "node:test";
import { looksCopiedFromInput } from "./replicateHelpers.ts";

// 이 검사가 느슨하면 대본이 그대로 제목으로 나가고(실제로 화면에 그렇게 나왔던 버그),
// 너무 빡세면 멀쩡한 문구를 버리고 기본 문구로 도망간다. 양쪽을 다 잡아둔다.

test("입력을 통째로 베끼면 걸러낸다", () => {
  const script = "백록담에서 등산오른 여성이 구름을 비닐에 담는";
  assert.equal(looksCopiedFromInput(script, script), true);
});

test("앞 몇 어절만 잘라낸 것도 걸러낸다", () => {
  // 모델이 실제로 이렇게 내놨었다 — 완전 일치만 봤다면 놓쳤을 패턴이다.
  assert.equal(
    looksCopiedFromInput(
      "백록담에서 등산오른 여성이 구름을",
      "백록담에서 등산오른 여성이 구름을 비닐에 담는",
    ),
    true,
  );
});

test("가운데 토막을 베낀 것도 걸러낸다", () => {
  assert.equal(
    looksCopiedFromInput("여성이 구름을", "백록담에서 등산오른 여성이 구름을 비닐에 담는"),
    true,
  );
});

test("새로 지어낸 문구는 통과시킨다", () => {
  assert.equal(
    looksCopiedFromInput("구름 포장 실화냐ㅋㅋㅋ", "백록담에서 등산오른 여성이 구름을 비닐에 담는"),
    false,
  );
});

test("입력의 어절을 써도 이어붙인 순서가 다르면 통과시킨다", () => {
  assert.equal(
    looksCopiedFromInput("구름을 백록담에서", "백록담에서 등산오른 여성이 구름을"),
    false,
  );
});

test("빈 문구는 실패로 본다", () => {
  assert.equal(looksCopiedFromInput("   ", "아무 대본"), true);
});

test("공백이 여러 칸이어도 같은 판정을 한다", () => {
  assert.equal(looksCopiedFromInput("여성이   구름을", "등산오른 여성이 구름을 담는"), true);
});

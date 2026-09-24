import assert from "node:assert/strict";
import { test } from "node:test";
import { MOCK_PROVIDER_MODEL, inFlightRealCostCents, remainingBudgetCents } from "./videoBudget.ts";
import type { VideoScene } from "./videoJobs.ts";

// 예산 계산이 틀리면 에러 없이 "예산보다 돈이 더 나가는" 결과만 남는다.

const scene = (over: Partial<VideoScene>): VideoScene =>
  ({
    id: "s",
    status: "queued",
    providerJobId: null,
    providerModel: null,
    generationHistory: [],
    ...over,
  }) as VideoScene;

const generating = (id: string, model: string, cost: number) =>
  scene({
    id,
    status: "generating",
    providerJobId: `job-${id}`,
    providerModel: model,
    generationHistory: [
      { providerJobId: `job-${id}`, videoUrl: null, costCents: cost, createdAt: "", status: "pending" },
    ],
  });

test("생성 중인 유료 장면의 예상 비용을 합친다", () => {
  const scenes = [generating("a", "gen4_turbo", 50), generating("b", "gen4_turbo", 50)];
  assert.equal(inFlightRealCostCents(scenes, "x"), 100);
});

test("지금 제출하려는 장면 자신은 빼고 센다", () => {
  const scenes = [generating("a", "gen4_turbo", 50), generating("b", "gen4_turbo", 50)];
  assert.equal(inFlightRealCostCents(scenes, "a"), 50);
});

test("무료 미리보기(mock)는 돈으로 치지 않는다", () => {
  const scenes = [generating("a", MOCK_PROVIDER_MODEL, 25), generating("b", "gen4_turbo", 50)];
  assert.equal(inFlightRealCostCents(scenes, "x"), 50);
});

test("이미 끝난 장면은 spentCents에 들어가 있으니 다시 세지 않는다", () => {
  const done = scene({ id: "a", status: "ready", providerJobId: "job-a", providerModel: "gen4_turbo" });
  assert.equal(inFlightRealCostCents([done], "x"), 0);
});

test("연달아 누르면 두 번째부터는 예산 초과로 막힌다", () => {
  // 예산 100, 장면당 50: 두 개까지는 되고 세 번째는 안 된다.
  const inFlight = inFlightRealCostCents(
    [generating("a", "gen4_turbo", 50), generating("b", "gen4_turbo", 50)],
    "c",
  );
  assert.ok(50 > remainingBudgetCents(100, 0, inFlight));
});

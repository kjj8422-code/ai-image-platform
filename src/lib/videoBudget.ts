import type { VideoScene } from "./videoJobs.ts";

// 예산 상한 판단에 쓰는 순수 계산. DB·공급자 없이 테스트할 수 있게 엔진에서 뺐다.

// 무료 미리보기(mock) 공급자가 남기는 모델 이름. 실제 돈이 나가지 않는다.
export const MOCK_PROVIDER_MODEL = "mock-echo-v0";

// 지금 "생성 중"인 유료 장면들이 곧 청구될 예상 금액의 합.
//
// job.spentCents는 결과가 나온 뒤에야 올라간다. 그래서 이 값을 빼고 예산을
// 비교하면, 진짜 생성을 여러 장면에 연달아 누를 때 각각은 통과하지만 합치면
// 예산을 넘는다. 아직 결과가 안 나온 유료 장면의 예상 비용도 "이미 쓴 돈"으로 친다.
export const inFlightRealCostCents = (
  scenes: readonly VideoScene[],
  excludeSceneId: string,
): number =>
  scenes
    .filter(
      (s) =>
        s.id !== excludeSceneId &&
        s.status === "generating" &&
        s.providerModel != null &&
        s.providerModel !== MOCK_PROVIDER_MODEL,
    )
    .reduce((sum, s) => {
      const pending = s.generationHistory.find(
        (h) => h.providerJobId === s.providerJobId && h.status === "pending",
      );
      return sum + (pending?.costCents ?? 0);
    }, 0);

export const remainingBudgetCents = (
  maxBudgetCents: number,
  spentCents: number,
  inFlightCents: number,
): number => maxBudgetCents - spentCents - inFlightCents;

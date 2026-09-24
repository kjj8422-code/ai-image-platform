import { getVideoProvider, getDefaultVideoProviderName } from "@/lib/videoProvider";
import { persistVideoClip } from "@/lib/videoStorage";
import {
  MOCK_PROVIDER_MODEL,
  inFlightRealCostCents,
  remainingBudgetCents,
} from "@/lib/videoBudget";
import {
  listScenesForJob,
  updateScene,
  incrementJobSpentCents,
  type VideoJob,
  type VideoScene,
  type GenerationHistoryEntry,
} from "@/lib/videoJobs";

export class BudgetExceededError extends Error {
  constructor(
    public readonly estimatedCostCents: number,
    public readonly remainingBudgetCents: number,
  ) {
    super(
      `예상 비용(${estimatedCostCents}센트)이 남은 예산(${remainingBudgetCents}센트)을 ` +
        `초과합니다. 예산을 늘리거나 다른 장면을 먼저 정리해주세요.`,
    );
  }
}

// 한 장면 안에서도 "1차 무료 미리보기(mock)"로 먼저 돌려보고, 마음에 들면
// "2차 최종 생성"으로 같은 장면을 실제 공급자로 다시 제출할 수 있다 — 그래서
// 공급자를 job 하나에 고정하지 않고 제출마다 고를 수 있게 한다(providerOverride).
// 문제는 poll(=advanceScene)할 때도 "그 장면을 실제로 어느 공급자에 보냈는지"를
// 알아야 하는데, job.provider 하나로는 장면마다 다를 수 있는 걸 못 담는다.
// 그래서 이미 제출된 장면은 provider_model(예: "mock-echo-v0" vs "gen4_turbo")로
// 역산한다 — 새 컬럼 없이 기존 데이터로 정확히 알아낼 수 있어서다.
export const REAL_VIDEO_PROVIDER_NAME = "runway";

const providerNameForScene = (job: VideoJob, scene: VideoScene): string => {
  if (scene.providerModel === MOCK_PROVIDER_MODEL) return "mock";
  if (scene.providerModel) return REAL_VIDEO_PROVIDER_NAME; // 지금 실제 공급자는 이거 하나뿐
  return job.provider ?? getDefaultVideoProviderName();
};

// 이미 생성 중인 장면을 다시 제출하지 않는다(멱등) — 연속 클릭·중복 요청 방지.
// ready/selected 상태를 다시 제출하는 건 "재생성"이라 호출부(API 라우트)가
// 명시적 확인을 받은 뒤에만 이 함수를 불러야 한다.
export const submitScene = async (
  job: VideoJob,
  scene: VideoScene,
  providerOverride?: string,
): Promise<VideoScene> => {
  if (scene.status === "generating") {
    return scene;
  }

  const providerName = providerOverride ?? job.provider ?? getDefaultVideoProviderName();
  const provider = getVideoProvider(providerName);
  const estimatedCostCents = provider.estimateCostCents(scene.durationTargetSeconds);

  // 무료 미리보기(mock)는 돈이 안 나가므로 예산과 비교하지 않는다. 예전엔 mock의
  // 가상 비용까지 비교해서, 예산이 거의 찬 작업에서는 공짜 미리보기조차 막혔다.
  if (providerName !== "mock" && job.maxBudgetCents != null) {
    const siblings = await listScenesForJob(job.id);
    const remaining = remainingBudgetCents(
      job.maxBudgetCents,
      job.spentCents,
      inFlightRealCostCents(siblings, scene.id),
    );
    if (estimatedCostCents > remaining) {
      throw new BudgetExceededError(estimatedCostCents, remaining);
    }
  }

  const result = await provider.submit({
    sourceImageUrl: scene.sourceImageUrl,
    referenceImageUrls: scene.referenceImageUrls,
    prompt: scene.prompt ?? "",
    durationSeconds: scene.durationTargetSeconds,
    aspectRatio: "9:16",
  });

  const historyEntry: GenerationHistoryEntry = {
    providerJobId: result.providerJobId,
    videoUrl: null,
    costCents: result.estimatedCostCents,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  return updateScene(scene.id, {
    status: "generating",
    providerJobId: result.providerJobId,
    providerModel: result.providerModel,
    // 전에 "저장만 실패"했던 임시 주소가 남아 있으면, 새 시도가 실패했을 때 저장
    // 재시도가 옛 영상을 새 결과처럼 붙여 버린다. 새로 제출할 때 지운다.
    providerRawUrl: null,
    error: null,
    generationHistory: [...scene.generationHistory, historyEntry],
  });
};

// Redis/BullMQ 같은 별도 큐·워커를 안 쓰는 이유: 이 프로젝트는 Vercel 서버리스 +
// Supabase 조합이고, 동시 사용자 수가 적다. "생성 중" 장면의 진행 상태는 전부
// DB(video_scenes.status/provider_job_id)에 있으므로, 공급자에게 "완료됐냐"고
// 다시 물어보기만 하면 된다 — 이건 상태가 있는 큐가 아니라 그냥 폴링이다.
//
// 그래서 advanceScene()은 두 군데에서 호출된다:
// 1) GET 상태 조회 라우트 — 사용자가 화면을 보고 있는 동안은 이 호출 자체가
//    폴링 역할을 한다(추가 인프라 없이 "실시간"에 가깝게 보임).
// 2) Vercel Cron이 주기적으로 호출하는 백스톱 라우트 — 사용자가 브라우저를 닫아도
//    작업이 멈추지 않고 계속 진행되게 한다(새로고침 후 복구 요건).
// 같은 장면을 두 경로가 동시에 건드릴 수 있어, lastPolledAt으로 조회 빈도를 제한한다
// (Runway 공식 문서 권장: 너무 자주 poll하지 말 것).
const MIN_POLL_INTERVAL_MS = 8000;

const shouldSkipPoll = (scene: VideoScene): boolean => {
  if (!scene.lastPolledAt) return false;
  return Date.now() - new Date(scene.lastPolledAt).getTime() < MIN_POLL_INTERVAL_MS;
};

// 영상은 다 만들어졌는데(=이미 돈을 냈는데) 우리 저장소로 옮기다 실패한 장면.
// 공급자 임시 주소가 살아 있는 동안 다시 옮겨 본다. 다시 생성하지 않으므로 추가
// 비용이 없고, 청구액은 처음 실패했을 때 이미 반영했으므로 여기서 더하지 않는다.
const needsSaveRetry = (scene: VideoScene): boolean =>
  scene.status === "failed" && Boolean(scene.providerRawUrl) && !scene.videoUrl;

const retrySavingClip = async (job: VideoJob, scene: VideoScene): Promise<VideoScene> => {
  const nowIso = new Date().toISOString();
  let permanentUrl: string;
  try {
    permanentUrl = await persistVideoClip(job.userId, scene.id, scene.providerRawUrl as string);
  } catch (err) {
    console.error(`영상 클립 저장 재시도 실패 (scene ${scene.id}):`, err);
    return updateScene(scene.id, { lastPolledAt: nowIso });
  }
  return updateScene(scene.id, {
    status: "ready",
    videoUrl: permanentUrl,
    error: null,
    lastPolledAt: nowIso,
    generationHistory: scene.generationHistory.map((h) =>
      h.providerJobId === scene.providerJobId
        ? { ...h, status: "ready" as const, videoUrl: permanentUrl, error: undefined }
        : h,
    ),
  });
};

// 'generating' 상태인 장면 하나를 한 단계 진행시킨다. 이미 끝났거나(ready/failed/
// selected) 아직 제출 전(queued)인 장면은 그대로 돌려준다(저장만 실패한 유료 장면은 저장을 다시 시도한다) — 호출부가 상태를 몰라도
// 안전하게 모든 장면에 대고 불러도 된다.
export const advanceScene = async (
  job: VideoJob,
  scene: VideoScene,
): Promise<VideoScene> => {
  if (needsSaveRetry(scene) && !shouldSkipPoll(scene)) {
    return retrySavingClip(job, scene);
  }
  if (scene.status !== "generating" || !scene.providerJobId) {
    return scene;
  }
  if (shouldSkipPoll(scene)) {
    return scene;
  }

  const providerName = providerNameForScene(job, scene);
  const provider = getVideoProvider(providerName);
  const nowIso = new Date().toISOString();
  // mock은 UI에서 "1차 무료 미리보기"로 쓰라고 만든 것이라 실제 돈이 안 나간다.
  // job.spent_cents(=예산 상한과 비교하는 값)를 mock 결과로 채우면, 미리보기만
  // 했는데도 예산이 소진돼 정작 "2차 진짜 생성"이 막히는 사고가 난다.
  const isRealProvider = providerName !== "mock";

  let result;
  try {
    result = await provider.poll(scene.providerJobId);
  } catch (err) {
    // 공급자 조회 자체가 실패(네트워크 등) — 장면을 실패로 단정 짓지 않는다.
    // 다음 폴링 때 다시 시도한다. lastPolledAt만 갱신해 짧은 시간에 재시도가
    // 몰리는 것만 막는다.
    console.error(`영상 장면 상태 조회 실패 (scene ${scene.id}):`, err);
    return updateScene(scene.id, { lastPolledAt: nowIso });
  }

  const pendingEntry = scene.generationHistory.find(
    (h) => h.providerJobId === scene.providerJobId && h.status === "pending",
  );

  if (result.status === "generating") {
    return updateScene(scene.id, { lastPolledAt: nowIso });
  }

  if (result.status === "ready") {
    let permanentUrl: string;
    try {
      permanentUrl = await persistVideoClip(job.userId, scene.id, result.videoUrl);
    } catch (err) {
      // 생성은 성공했는데 우리 쪽 저장이 실패한 경우. 이미 돈은 나갔으므로 spent는
      // 반영하되, 재생성(=재과금) 없이 다음 폴링에서 다시 다운로드를 시도할 수 있게
      // provider_raw_url을 보관해 둔다.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`영상 클립 저장 실패 (scene ${scene.id}):`, err);
      if (isRealProvider) await incrementJobSpentCents(job.id, result.actualCostCents);
      return updateScene(scene.id, {
        status: "failed",
        error: `영상 생성은 완료됐지만 저장에 실패했습니다: ${message}`,
        providerRawUrl: result.videoUrl,
        lastPolledAt: nowIso,
        generationHistory: scene.generationHistory.map((h) =>
          h === pendingEntry
            ? { ...h, status: "failed" as const, error: message, costCents: result.actualCostCents }
            : h,
        ),
      });
    }

    if (isRealProvider) await incrementJobSpentCents(job.id, result.actualCostCents);
    return updateScene(scene.id, {
      status: "ready",
      videoUrl: permanentUrl,
      providerRawUrl: result.videoUrl,
      error: null,
      lastPolledAt: nowIso,
      generationHistory: scene.generationHistory.map((h) =>
        h === pendingEntry
          ? { ...h, status: "ready" as const, videoUrl: permanentUrl, costCents: result.actualCostCents }
          : h,
      ),
    });
  }

  // result.status === "failed"
  // 공급자가 실패 시 정확한 청구액을 안 준다(charged 여부만 준다) — 제출 시점에
  // 적어둔 예상 비용(pendingEntry.costCents)을 근사치로 쓴다. 실제 청구 내역은
  // 공급자 대시보드가 정본이다.
  const chargedAmount = result.charged ? (pendingEntry?.costCents ?? 0) : 0;
  if (isRealProvider && chargedAmount > 0) {
    await incrementJobSpentCents(job.id, chargedAmount);
  }
  return updateScene(scene.id, {
    status: "failed",
    error: result.error,
    lastPolledAt: nowIso,
    generationHistory: scene.generationHistory.map((h) =>
      h === pendingEntry
        ? { ...h, status: "failed" as const, costCents: chargedAmount, error: result.error }
        : h,
    ),
  });
};

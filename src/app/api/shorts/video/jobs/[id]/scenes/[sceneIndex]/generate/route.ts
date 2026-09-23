import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedScene } from "@/lib/videoJobs";
import { submitScene, BudgetExceededError, REAL_VIDEO_PROVIDER_NAME } from "@/lib/videoJobEngine";

export const maxDuration = 30;

// 장면 하나를 영상 생성 공급자에 제출한다. body의 provider로 어느 쪽을 쓸지 매
// 요청마다 고른다 — "mock"(1차 무료 미리보기, 비용 0원) 또는 "real"(2차 최종
// 생성, 실제 공급자·실비용). 안 보내면 서버 기본값(VIDEO_PROVIDER 환경변수,
// 평소엔 mock)을 쓴다. "real"을 실제로 쓰려면 서버에 RUNWAYML_API_SECRET이
// 등록돼 있어야 한다 — 없으면 명확한 오류로 실패한다(자동으로 mock으로 대체하지
// 않는다. 그러면 사용자가 "진짜 생성"을 눌렀는데 조용히 mock이 도는 사고가 난다).
//
// 멱등성: 이미 'generating' 상태면 재제출하지 않고 현재 상태를 그대로 돌려준다
// (연속 클릭 방지). 이미 'ready'/'selected'인 장면을 다시 만들려면(=재생성,
// 재과금 가능성) body에 { regenerate: true }를 명시적으로 보내야 한다.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sceneIndex: string }> },
) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { id, sceneIndex: sceneIndexRaw } = await params;
    const sceneIndex = Number(sceneIndexRaw);
    if (!Number.isInteger(sceneIndex)) {
      return NextResponse.json({ error: "잘못된 장면 번호입니다." }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const regenerate = body?.regenerate === true;
    const providerChoice: string | undefined =
      body?.provider === "real"
        ? REAL_VIDEO_PROVIDER_NAME
        : body?.provider === "mock"
          ? "mock"
          : undefined;

    const found = await getOwnedScene(auth.user.id, id, sceneIndex);
    if (!found) {
      return NextResponse.json({ error: "장면을 찾을 수 없습니다." }, { status: 404 });
    }
    const { job, scene } = found;

    if (job.status !== "reviewable" && job.status !== "editing") {
      return NextResponse.json(
        { error: `이 작업은 지금 장면을 생성할 수 있는 상태가 아닙니다 (${job.status}).` },
        { status: 409 },
      );
    }

    if ((scene.status === "ready" || scene.status === "selected") && !regenerate) {
      return NextResponse.json(
        {
          error:
            "이미 생성된 장면입니다. 다시 만들려면 재생성을 명시적으로 요청해주세요(비용이 다시 듭니다).",
        },
        { status: 409 },
      );
    }

    try {
      const updated = await submitScene(job, scene, providerChoice);
      return NextResponse.json({ scene: updated });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return NextResponse.json(
          {
            error: err.message,
            estimatedCostCents: err.estimatedCostCents,
            remainingBudgetCents: err.remainingBudgetCents,
          },
          { status: 402 },
        );
      }
      throw err;
    }
  } catch (err) {
    console.error("영상 장면 생성 요청 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

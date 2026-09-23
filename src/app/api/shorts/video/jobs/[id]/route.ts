import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedJob, listScenesForJob } from "@/lib/videoJobs";
import { advanceScene } from "@/lib/videoJobEngine";

export const maxDuration = 30;

// 작업 상태 + 장면 목록을 돌려준다. 'generating' 상태인 장면이 있으면 응답하기
// 전에 공급자에게 한 번 물어봐서(advanceScene) 최신 상태를 반영한다 — 화면이 이
// 라우트를 주기적으로 부르는 것 자체가 폴링 역할을 한다(videoJobEngine.ts 설명 참고).
// 새로고침하거나 나중에 다시 들어와도 DB에서 바로 이어서 보여줄 수 있다.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { id } = await params;
    const job = await getOwnedJob(auth.user.id, id);
    if (!job) {
      return NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
    }

    const scenes = await listScenesForJob(job.id);
    const anyMoving = scenes.some((s) => s.status === "generating");
    const advanced = await Promise.all(
      scenes.map(async (scene) => {
        try {
          return await advanceScene(job, scene);
        } catch (err) {
          // 한 장면의 폴링 실패가 나머지 장면·화면 전체를 막으면 안 된다.
          console.error(`장면 상태 갱신 실패 (scene ${scene.id}):`, err);
          return scene;
        }
      }),
    );

    // advanceScene이 job.spent_cents를 DB에서 바로 올릴 수 있어(완료/실패 판정 시),
    // 위에서 미리 읽어둔 job 스냅샷은 그새 구식이 될 수 있다. 장면을 하나라도
    // 건드렸다면 다시 읽어 최신 금액을 돌려준다.
    const freshJob = anyMoving ? await getOwnedJob(auth.user.id, id) : job;

    return NextResponse.json({ job: freshJob ?? job, scenes: advanced });
  } catch (err) {
    console.error("AI 영상 쇼츠 작업 조회 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

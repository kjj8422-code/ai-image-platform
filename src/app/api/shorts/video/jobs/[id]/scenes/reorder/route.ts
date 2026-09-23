import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedJob, listScenesForJob, reorderScenes } from "@/lib/videoJobs";

export const maxDuration = 15;

// 장면 순서를 바꾼다. 영상 클립·나레이션은 그대로 두고 화면/최종본에서 재생되는
// 순서(scene_index)만 바뀐다 — 비용이 드는 작업이 전혀 없다.
export async function PATCH(
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

    const body = await request.json();
    const order: unknown = body?.order;
    if (!Array.isArray(order) || !order.every((v) => typeof v === "string")) {
      return NextResponse.json(
        { error: "order는 장면 id 문자열 배열이어야 합니다." },
        { status: 400 },
      );
    }

    const current = await listScenesForJob(job.id);
    const currentIds = new Set(current.map((s) => s.id));
    const sameSet =
      order.length === current.length && order.every((id) => currentIds.has(id));
    if (!sameSet) {
      return NextResponse.json(
        { error: "order가 이 작업의 장면 목록과 정확히 일치하지 않습니다." },
        { status: 400 },
      );
    }

    const scenes = await reorderScenes(job.id, order);
    return NextResponse.json({ scenes });
  } catch (err) {
    console.error("영상 장면 순서 변경 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

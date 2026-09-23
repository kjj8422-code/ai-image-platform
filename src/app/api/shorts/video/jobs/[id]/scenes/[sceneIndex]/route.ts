import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedScene, updateScene } from "@/lib/videoJobs";

export const maxDuration = 15;

// 장면 생성 전에(또는 실패해서 다시 손볼 때) 나레이션·자막·프롬프트를 직접
// 고칠 수 있게 한다. "사람이 장면을 확인하고 채택·재생성할 수 있게" 하라는
// 요구사항 중 "확인 후 고치기" 부분 — 재생성(비용 발생)과는 분리된, 무료 작업이다.
export async function PATCH(
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

    const found = await getOwnedScene(auth.user.id, id, sceneIndex);
    if (!found) {
      return NextResponse.json({ error: "장면을 찾을 수 없습니다." }, { status: 404 });
    }
    const { scene } = found;

    // 생성 중이거나 이미 완성된 장면의 대본을 바꾸면 화면에 보이는 텍스트와
    // 실제로 공급자에 보낸(또는 보낼) 내용이 어긋난다. 손보려면 먼저 재생성으로
    // 새 요청을 만들어야 한다(그 시점엔 그때의 narration/prompt가 그대로 쓰인다).
    if (scene.status !== "queued" && scene.status !== "failed") {
      return NextResponse.json(
        {
          error:
            "생성 중이거나 이미 완성된 장면은 수정할 수 없습니다. 다시 만들기(재생성)를 이용해주세요.",
        },
        { status: 409 },
      );
    }

    const body = await request.json();
    const patch: Parameters<typeof updateScene>[1] = {};
    if (typeof body?.narration === "string") patch.narration = body.narration;
    if (typeof body?.subtitle === "string") patch.subtitle = body.subtitle;
    if (typeof body?.prompt === "string") patch.prompt = body.prompt;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "수정할 내용이 없습니다." }, { status: 400 });
    }

    const updated = await updateScene(scene.id, patch);
    return NextResponse.json({ scene: updated });
  } catch (err) {
    console.error("영상 장면 수정 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

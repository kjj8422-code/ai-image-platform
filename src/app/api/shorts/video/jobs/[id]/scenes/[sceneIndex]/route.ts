import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedScene, updateScene } from "@/lib/videoJobs";
import { SFX_LIBRARY } from "@/lib/shortsStoryboard";

const isSfxCue = (value: unknown): value is (typeof SFX_LIBRARY)[number] =>
  typeof value === "string" && (SFX_LIBRARY as readonly string[]).includes(value);

export const maxDuration = 15;

// 나레이션·자막·프롬프트를 직접 고칠 수 있게 한다. "사람이 장면을 확인하고
// 채택·재생성할 수 있게" 하라는 요구사항 중 "확인 후 고치기" 부분 — 재생성(비용
// 발생 가능)과는 분리된, 무료 작업이다.
//
// narration/subtitle은 영상 클립과 완전히 분리된 데이터라(최종 렌더링 때 TTS·
// 자막으로만 쓰인다) 장면이 어느 상태든 — 1차 미리보기가 끝난 뒤라도 — 자유롭게
// 고칠 수 있다. 반대로 prompt는 공급자에 실제로 보낸(또는 보낼) 지시문 그 자체라,
// 이미 제출된 뒤에 바꾸면 화면 문구와 실제 생성 결과가 어긋난다 — 그래서 prompt만
// queued/failed일 때로 제한한다.
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

    const body = await request.json();
    const patch: Parameters<typeof updateScene>[1] = {};
    if (typeof body?.narration === "string") patch.narration = body.narration;
    if (typeof body?.subtitle === "string") patch.subtitle = body.subtitle;
    if (isSfxCue(body?.sfx)) patch.sfx = body.sfx;

    if (typeof body?.prompt === "string") {
      if (scene.status !== "queued" && scene.status !== "failed") {
        return NextResponse.json(
          {
            error:
              "이미 제출됐거나 완성된 장면의 프롬프트는 못 바꿉니다(실제 생성 결과와 어긋나요). " +
              "다시 만들기(재생성)를 이용해주세요.",
          },
          { status: 409 },
        );
      }
      patch.prompt = body.prompt;
    }

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

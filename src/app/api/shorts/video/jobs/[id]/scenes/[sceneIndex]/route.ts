import { composeEditedVisualPrompt, VISUAL_LIMITS } from "@/lib/videoSceneEditing";
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
// 고칠 수 있다. 장면 설명 수정은 다음 생성부터 적용되며 기존 영상은 보존한다.
// 생성 또는 저장 중에는 설명 변경을 막는다.
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
    if (body.sceneId && body.sceneId !== scene.id) return NextResponse.json({ error: "장면 순서가 바뀌었습니다. 새로고침 후 다시 시도하세요." }, { status: 409 });
    const patch: Parameters<typeof updateScene>[1] = {};
    if (typeof body?.narration === "string") patch.narration = body.narration;
    if (typeof body?.subtitle === "string") patch.subtitle = body.subtitle;
    if (isSfxCue(body?.sfx)) patch.sfx = body.sfx;

    const visualKeys = ["keyAction", "cameraMotion", "preserveNotes"] as const;
    const visualChange = visualKeys.some(key => body[key] !== undefined) || body.prompt !== undefined;
    if (visualChange) {
      if (scene.status === "generating" || scene.providerRawUrl && !scene.videoUrl) return NextResponse.json({ error: "영상 생성·저장이 끝난 뒤 장면 설명을 수정하세요." }, { status: 409 });
      for (const key of visualKeys) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "string" || body[key].length > VISUAL_LIMITS[key] || key === "keyAction" && !body[key].trim()) return NextResponse.json({ error: `동작은 ${VISUAL_LIMITS.keyAction}자, 카메라는 ${VISUAL_LIMITS.cameraMotion}자, 유지할 요소는 ${VISUAL_LIMITS.preserveNotes}자 이내로 입력하세요. 동작은 비워둘 수 없습니다.` }, { status: 400 });
          patch[key] = body[key].trim();
        }
      }
      if (visualKeys.some(key => body[key] !== undefined)) patch.prompt = composeEditedVisualPrompt({ ...scene, ...patch });
      else if (typeof body.prompt === "string" && body.prompt.trim().length > 0 && body.prompt.length <= 1000) patch.prompt = body.prompt;
      else return NextResponse.json({ error: "올바른 장면 설명을 입력하세요." }, { status: 400 });
      if (patch.prompt && patch.prompt.length > 1000) return NextResponse.json({ error: "기존 설명이 너무 깁니다. 동작·카메라·유지할 요소를 모두 짧게 수정해 주세요." }, { status: 400 });
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

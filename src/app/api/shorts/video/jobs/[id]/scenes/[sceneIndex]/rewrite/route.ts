import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedScene, updateScene } from "@/lib/videoJobs";
import { rewriteSceneNarration, MissingAnthropicKeyError } from "@/lib/videoScenePlanner";

export const maxDuration = 30;

// "다른 대본" 버튼: 장면 하나의 나레이션/자막/효과음만 Claude로 다시 뽑는다.
// 영상 클립(keyAction/cameraMotion/preserveNotes/prompt)은 건드리지 않으므로
// 이미 생성된 장면이어도 자유롭게 눌러도 된다 — 나레이션은 항상 무료로 고칠 수
// 있다는 기존 규칙과 같은 이유(PATCH 라우트 참고). 단, 이 호출 자체는 실제
// Claude API 호출이라 비용이 든다 — CLAUDE.md 규칙상 채팅에서 매번 다시 승인받는
// 대신, 화면 버튼에 비용을 명시해 그 클릭 자체를 승인으로 본다.
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

    const found = await getOwnedScene(auth.user.id, id, sceneIndex);
    if (!found) {
      return NextResponse.json({ error: "장면을 찾을 수 없습니다." }, { status: 404 });
    }
    const { job, scene } = found;

    try {
      const rewritten = await rewriteSceneNarration(
        scene.sourceImageUrl,
        job.style,
        scene.narration ?? "",
        job.narrationEnabled,
        job.subtitleEnabled,
      );
      const updated = await updateScene(scene.id, {
        narration: rewritten.narration,
        subtitle: rewritten.subtitle,
        sfx: rewritten.sfx,
      });
      return NextResponse.json({ scene: updated });
    } catch (err) {
      if (err instanceof MissingAnthropicKeyError) {
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
      throw err;
    }
  } catch (err) {
    console.error("영상 장면 대본 재생성 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

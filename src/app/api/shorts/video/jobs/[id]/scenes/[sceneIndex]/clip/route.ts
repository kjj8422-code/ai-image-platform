import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getOwnedScene, attachUploadedClip } from "@/lib/videoJobs";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { MAX_CLIP_BYTES, ownsClipPath, validClipFile } from "@/lib/sceneClipUpload";

export const maxDuration = 30;
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; sceneIndex: string }> }) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id, sceneIndex } = await params;
    if (!Number.isInteger(Number(sceneIndex))) return NextResponse.json({ error: "잘못된 장면 번호입니다." }, { status: 400 });
    const found = await getOwnedScene(auth.user.id, id, Number(sceneIndex));
    if (!found) return NextResponse.json({ error: "장면을 찾을 수 없습니다." }, { status: 404 });
    const body = await request.json();
    const { scene, job } = found;
    if (body.sceneId !== scene.id || !["reviewable", "editing"].includes(job.status) || scene.status === "generating" || (scene.providerRawUrl && !scene.videoUrl)) {
      return NextResponse.json({ error: "장면이 변경되었거나 생성·저장 중입니다. 완료 후 다시 시도하세요." }, { status: 409 });
    }
    const storage = getSupabaseAdmin().storage.from("gallery");
    if (body.action === "sign") {
      if (typeof body.name !== "string" || !validClipFile(body.name, body.size)) return NextResponse.json({ error: "50MB 이하의 MP4 파일을 선택하세요." }, { status: 400 });
      const path = `${auth.user.id}/scene-uploads/${scene.id}/${randomUUID()}.mp4`;
      const { data, error } = await storage.createSignedUploadUrl(path);
      if (error) throw error;
      return NextResponse.json({ path, token: data.token, version: scene.updatedAt });
    }
    if (body.action !== "complete" || !ownsClipPath(body.path, auth.user.id, scene.id)) return NextResponse.json({ error: "올바르지 않은 업로드 경로입니다." }, { status: 400 });
    if (typeof body.version !== "string" || body.version !== scene.updatedAt) return NextResponse.json({ error: "업로드 중 장면이 변경되었습니다. 새로고침 후 다시 올려 주세요." }, { status: 409 });
    const { data: info, error } = await storage.info(body.path);
    if (error || !info || !info.size || info.size > MAX_CLIP_BYTES || info.contentType !== "video/mp4") return NextResponse.json({ error: "MP4 업로드를 확인하지 못했습니다. 파일 크기와 형식을 확인하세요." }, { status: 400 });
    const { data: { publicUrl } } = storage.getPublicUrl(body.path);
    const updated = await attachUploadedClip(scene, publicUrl, body.path);
    if (!updated) return NextResponse.json({ error: "장면이 변경되어 연결하지 못했습니다. 새로고침 후 다시 시도하세요." }, { status: 409 });
    return NextResponse.json({ scene: updated });
  } catch (err) {
    console.error("장면 영상 업로드 오류", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "영상 업로드에 실패했습니다." }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import { getOwnedGalleryImages } from "@/lib/gallery";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import {
  enhancePrompt,
  extractImageUrl,
  withRetryOn429,
} from "@/lib/replicateHelpers";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

export const maxDuration = 60;

// 마스킹 편집: 저장된 이미지 1장 + 사용자가 브러시로 칠한 영역(마스크) + 프롬프트를
// 받아, 칠한 부분만 새로 그려 넣는다(인페인팅). 칠하지 않은 부분은 원본 그대로 유지.
export async function POST(request: NextRequest) {
  try {
    if (!replicateApiToken) {
      return NextResponse.json(
        { error: "서버 설정 오류: Replicate 토큰이 누락되었습니다." },
        { status: 500 },
      );
    }

    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const imageId = typeof body?.imageId === "string" ? body.imageId : "";
    const maskDataUrl =
      typeof body?.maskDataUrl === "string" ? body.maskDataUrl : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    if (!imageId || !maskDataUrl || !prompt) {
      return NextResponse.json(
        { error: "이미지, 칠한 영역, 프롬프트가 모두 필요합니다." },
        { status: 400 },
      );
    }

    const [ownedImage] = await getOwnedGalleryImages(auth.user.id, [imageId]);
    if (!ownedImage) {
      return NextResponse.json(
        { error: "접근할 수 없는 이미지입니다." },
        { status: 403 },
      );
    }

    // "data:image/png;base64,...." 형식에서 실제 바이너리만 추출해 업로드
    const base64 = maskDataUrl.replace(/^data:image\/\w+;base64,/, "");
    const maskBytes = Buffer.from(base64, "base64");

    const supabaseAdmin = getSupabaseAdmin();
    const maskPath = `${auth.user.id}/masks/${randomUUID()}.png`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("gallery")
      .upload(maskPath, maskBytes, { contentType: "image/png", upsert: false });
    if (uploadError) {
      throw uploadError;
    }

    const {
      data: { publicUrl: maskUrl },
    } = supabaseAdmin.storage.from("gallery").getPublicUrl(maskPath);

    const replicate = new Replicate({ auth: replicateApiToken });

    // 한글 등 비영어 입력도 정확히 반영되도록 번역·보강
    const enhancedPrompt = await enhancePrompt(replicate, prompt);

    const output = await withRetryOn429(() =>
      replicate.run("black-forest-labs/flux-fill-pro", {
        input: {
          image: ownedImage.imageUrl,
          mask: maskUrl,
          prompt: enhancedPrompt,
        },
      }),
    );

    const imageUrl = extractImageUrl(output);

    return NextResponse.json({ imageUrl, enhancedPrompt });
  } catch (err) {
    console.error("마스킹 편집 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "편집 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

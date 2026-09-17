import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import { getOwnedGalleryImages } from "@/lib/gallery";
import { enhancePrompt, extractImageUrl, withRetryOn429 } from "@/lib/replicateHelpers";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

export const maxDuration = 60;

// 합성/리믹스 전용 번역·보강 지침. 일반 이미지 설명 보강과 달리, "따로따로
// 배치된 콜라주"가 아니라 "하나의 사진처럼 자연스럽게 합쳐진 장면"이 나오도록
// 모델에게 명시적으로 지시하는 문구를 항상 덧붙인다.
const REMIX_INSTRUCTION =
  "Translate and enhance the following image-editing instruction into a single, clear English instruction for an AI photo-compositing model that merges multiple reference images. " +
  "Output ONLY the final English instruction with no preamble, no quotes, no explanation. " +
  "Always make sure the instruction explicitly asks for ONE seamless, cohesive photograph with a single unified background, consistent lighting and perspective across all subjects — and explicitly forbid a collage, split-screen, grid, or side-by-side arrangement of separate images.";

// 갤러리에 저장해둔 이미지 2장 이상을 참고 이미지로 지정해, 새 프롬프트로
// 하나의 합성된 이미지를 만든다. (Flux Kontext의 다중 이미지 참조 기능 사용)
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
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const imageIds = Array.isArray(body?.imageIds)
      ? body.imageIds.filter((id: unknown): id is string => typeof id === "string")
      : [];

    if (!prompt) {
      return NextResponse.json(
        { error: "합성할 방향을 설명하는 프롬프트를 입력해주세요." },
        { status: 400 },
      );
    }

    if (imageIds.length < 2) {
      return NextResponse.json(
        { error: "참고 이미지를 2장 이상 선택해주세요." },
        { status: 400 },
      );
    }

    // 본인 소유 이미지인지 확인 (다른 사람 갤러리 이미지를 무단으로 참고하지 못하게)
    const ownedImages = await getOwnedGalleryImages(auth.user.id, imageIds);
    if (ownedImages.length !== imageIds.length) {
      return NextResponse.json(
        { error: "선택한 이미지 중 접근할 수 없는 항목이 있습니다." },
        { status: 403 },
      );
    }

    const replicate = new Replicate({ auth: replicateApiToken });

    // 한글 등 비영어 입력도 정확히 반영되도록 번역·보강 + "콜라주 금지, 한 장면으로
    // 자연스럽게 합치기" 지침을 자동으로 덧붙인다.
    const enhancedPrompt = await enhancePrompt(
      replicate,
      prompt,
      REMIX_INSTRUCTION,
    );

    const output = await withRetryOn429(() =>
      replicate.run("flux-kontext-apps/multi-image-list", {
        input: {
          prompt: enhancedPrompt,
          input_images: ownedImages.map((image) => image.imageUrl),
        },
      }),
    );

    const imageUrl = extractImageUrl(output);

    return NextResponse.json({ imageUrl, enhancedPrompt });
  } catch (err) {
    console.error("합성 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "합성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

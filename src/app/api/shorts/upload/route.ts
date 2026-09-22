import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { uploadSourceImage } from "@/lib/gallery";
import { MAX_IMAGES } from "@/lib/shortsFromImages";

export const maxDuration = 60;

// 브라우저에서 올린 쇼츠 소재 이미지를 스토리지에 저장하고 공개 URL을 돌려준다.
// Claude 비전 분석과 로컬 렌더러 양쪽이 이 URL을 그대로 쓴다.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const rawImages: unknown = body?.imageDataUrls;
    const dataUrls = Array.isArray(rawImages)
      ? rawImages.filter((value): value is string => typeof value === "string")
      : [];

    if (dataUrls.length === 0) {
      return NextResponse.json(
        { error: "업로드할 이미지가 없습니다." },
        { status: 400 },
      );
    }
    if (dataUrls.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: `한 번에 최대 ${MAX_IMAGES}장까지 올릴 수 있습니다.` },
        { status: 400 },
      );
    }

    const imageUrls: string[] = [];
    for (const dataUrl of dataUrls) {
      imageUrls.push(await uploadSourceImage(auth.user.id, dataUrl));
    }

    return NextResponse.json({ imageUrls });
  } catch (err) {
    console.error("쇼츠 소재 업로드 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "업로드 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import {
  saveImageToGallery,
  saveDataUrlToGallery,
  type GalleryImageSource,
} from "@/lib/gallery";

const VALID_SOURCES: GalleryImageSource[] = [
  "generated",
  "remix",
  "inpaint",
  "thumbnail",
];

const parseSource = (value: unknown): GalleryImageSource =>
  VALID_SOURCES.includes(value as GalleryImageSource)
    ? (value as GalleryImageSource)
    : "generated";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl : "";
    const imageDataUrl =
      typeof body?.imageDataUrl === "string" ? body.imageDataUrl : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    const source = parseSource(body?.source);

    if (!imageUrl && !imageDataUrl) {
      return NextResponse.json(
        { error: "저장할 이미지가 없습니다." },
        { status: 400 },
      );
    }

    const saved = imageDataUrl
      ? await saveDataUrlToGallery(auth.user.id, imageDataUrl, prompt, source)
      : await saveImageToGallery(auth.user.id, imageUrl, prompt, source);

    return NextResponse.json({ image: saved });
  } catch (err) {
    console.error("갤러리 저장 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "저장 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

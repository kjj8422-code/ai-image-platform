import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { saveImageToGallery } from "@/lib/gallery";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    const source = body?.source === "remix" ? "remix" : "generated";

    if (!imageUrl) {
      return NextResponse.json(
        { error: "저장할 이미지가 없습니다." },
        { status: 400 },
      );
    }

    const saved = await saveImageToGallery(
      auth.user.id,
      imageUrl,
      prompt,
      source,
    );

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

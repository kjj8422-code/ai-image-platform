import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { listGalleryImages } from "@/lib/gallery";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const images = await listGalleryImages(auth.user.id);

    return NextResponse.json({ images });
  } catch (err) {
    console.error("갤러리 조회 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "조회 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

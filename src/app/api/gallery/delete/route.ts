import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { deleteGalleryImage } from "@/lib/gallery";

// 갤러리에서 이미지 1장을 지운다. 본인 이미지만 지울 수 있다.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json().catch(() => null);
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id) {
      return NextResponse.json({ error: "지울 이미지가 없습니다." }, { status: 400 });
    }

    const deleted = await deleteGalleryImage(auth.user.id, id);
    if (!deleted) {
      return NextResponse.json(
        { error: "이미지를 찾을 수 없거나 지울 수 없는 이미지입니다." },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("갤러리 삭제 오류:", err);
    const message =
      err instanceof Error ? err.message : "삭제 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

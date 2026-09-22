import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";
import { composeThumbnail } from "@/lib/thumbnailServerCanvas";

export const maxDuration = 30;

const MAX_BYTES = 25 * 1024 * 1024;

// 배경 이미지 URL + 문구를 받아 서버에서 9:16 썸네일 PNG를 합성해 그대로
// 돌려준다. 클라이언트는 이 결과를 미리보기/다운로드/저장에 그대로 쓴다.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const backgroundUrl =
      typeof body?.backgroundUrl === "string" ? body.backgroundUrl : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";

    if (!backgroundUrl || !title) {
      return NextResponse.json(
        { error: "배경 이미지와 문구가 모두 필요합니다." },
        { status: 400 },
      );
    }

    // 다운로드 라우트와 같은 허용 목록으로 SSRF를 막는다 — 이 라우트도 클라이언트가
    // 지정한 URL을 서버가 대신 fetch하는 구조라 같은 위험이 있다.
    const target = parseAllowedImageUrl(
      backgroundUrl,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
    if (!target) {
      return NextResponse.json(
        { error: "허용되지 않은 이미지 주소입니다." },
        { status: 400 },
      );
    }

    const upstream = await fetch(target.toString());
    if (!upstream.ok) {
      return NextResponse.json(
        { error: "배경 이미지를 가져오지 못했습니다." },
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return NextResponse.json(
        { error: "이미지 파일이 아닙니다." },
        { status: 502 },
      );
    }
    if (Number(upstream.headers.get("content-length") ?? 0) > MAX_BYTES) {
      return NextResponse.json({ error: "파일이 너무 큽니다." }, { status: 413 });
    }

    const backgroundBytes = Buffer.from(await upstream.arrayBuffer());
    const pngBuffer = composeThumbnail({ backgroundBytes, titleText: title });

    return new NextResponse(new Uint8Array(pngBuffer), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("썸네일 합성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "합성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

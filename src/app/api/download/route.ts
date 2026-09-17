import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";

// 브라우저의 <a download> 속성은 "같은 도메인" 파일에만 동작한다.
// 우리 이미지는 Replicate CDN과 Supabase Storage에 있어서 다른 도메인이고,
// 그래서 download가 무시된 채 새 탭에서 열리기만 했다.
//
// 이 라우트가 서버에서 파일을 받아 Content-Disposition: attachment 를 붙여
// 다시 내려준다. 그러면 PC·휴대폰 모두 실제 "저장"으로 동작한다.

const MAX_BYTES = 25 * 1024 * 1024;

// 저장될 파일 이름을 만든다. 원본 경로의 확장자를 살리고, 없으면
// 실제 Content-Type에서 가져온다.
const buildFileName = (pathname: string, contentType: string): string => {
  const fromPath = /\.(png|jpe?g|webp)$/i.exec(pathname)?.[1]?.toLowerCase();
  const fromType = contentType.includes("webp")
    ? "webp"
    : contentType.includes("jpeg")
      ? "jpg"
      : "png";
  const extension = (fromPath === "jpeg" ? "jpg" : fromPath) ?? fromType;

  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return `ai-image-${stamp}.${extension}`;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const rawUrl = request.nextUrl.searchParams.get("url") ?? "";
    if (!rawUrl) {
      return NextResponse.json(
        { error: "내려받을 이미지 주소가 없습니다." },
        { status: 400 },
      );
    }

    const target = parseAllowedImageUrl(
      rawUrl,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
    if (!target) {
      return NextResponse.json(
        { error: "허용되지 않은 이미지 주소입니다." },
        { status: 400 },
      );
    }

    const upstream = await fetch(target.toString());
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: "원본 이미지를 가져오지 못했습니다." },
        { status: 502 },
      );
    }

    // 이미지가 아닌 응답을 그대로 흘려보내지 않는다.
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

    const fileName = buildFileName(target.pathname, contentType);

    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("다운로드 오류:", err);
    return NextResponse.json(
      { error: "다운로드 중 알 수 없는 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

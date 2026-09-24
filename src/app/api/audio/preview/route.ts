import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { resolvePreviewFile } from "@/lib/audioCatalog";

// 효과음·배경음악 미리듣기. 실제 mp3는 PC 합성기용 폴더(.claude/skills/viral-shorts/
// assets)에 있고, next.config.ts의 outputFileTracingIncludes로 이 라우트에만 실어 보낸다.
//
// public/에 복사해 아무나 받게 하지 않는다. 기본 효과음 일부(Sonniss)는 "영상 제작용"
// 라이선스라 파일 자체를 공개 배포하면 안 되고, 로그인한 사용자가 도구 안에서 들어보는
// 것까지만 괜찮다. 목록에 있는 이름만 받아서 경로 조작(../)도 원천 차단한다.
const ASSETS_DIR = path.join(process.cwd(), ".claude", "skills", "viral-shorts", "assets");

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const kind = request.nextUrl.searchParams.get("kind") ?? "";
    const name = request.nextUrl.searchParams.get("name") ?? "";
    const file = resolvePreviewFile(kind, name);
    if (!file) {
      return NextResponse.json({ error: "미리듣기가 없는 소리입니다." }, { status: 404 });
    }

    const bytes = await readFile(path.join(ASSETS_DIR, file.kind, `${file.name}.mp3`));
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "audio/mpeg",
        // 같은 소리를 여러 번 눌러도 매번 받지 않게 브라우저에만 잠깐 보관한다.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("미리듣기 오류:", err);
    return NextResponse.json({ error: "소리를 불러오지 못했습니다." }, { status: 500 });
  }
}

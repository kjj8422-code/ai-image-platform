import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import { suggestThumbnailCopy } from "@/lib/replicateHelpers";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

export const maxDuration = 30;

// 한 줄 대본/키워드를 받아 쇼츠 썸네일용 문구(3~4단어)와 배경 생성용 영문
// 프롬프트를 함께 추천한다.
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
    const script = typeof body?.script === "string" ? body.script.trim() : "";

    if (!script) {
      return NextResponse.json(
        { error: "대본이나 키워드를 입력해주세요." },
        { status: 400 },
      );
    }

    const replicate = new Replicate({ auth: replicateApiToken });
    const suggestion = await suggestThumbnailCopy(replicate, script);

    return NextResponse.json(suggestion);
  } catch (err) {
    console.error("썸네일 문구 추천 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "문구 추천 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

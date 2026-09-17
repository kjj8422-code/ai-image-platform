import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import { extractImageUrl, withRetryOn429 } from "@/lib/replicateHelpers";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

export const maxDuration = 30;

// 이미지 1장의 배경을 제거해 투명 PNG로 만든다 (누끼컷). 로고/제품 이미지처럼
// 배경 없이 납품해야 하는 작업물에 사용.
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
    const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl : "";

    if (!imageUrl) {
      return NextResponse.json(
        { error: "배경을 제거할 이미지가 없습니다." },
        { status: 400 },
      );
    }

    const replicate = new Replicate({ auth: replicateApiToken });

    const output = await withRetryOn429(() =>
      // 이 모델은 "owner/name" 축약 호출을 지원하지 않아 버전을 명시해야 한다.
      replicate.run(
        "851-labs/background-remover:a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
        { input: { image: imageUrl, format: "png" } },
      ),
    );

    const resultUrl = extractImageUrl(output);

    return NextResponse.json({ imageUrl: resultUrl });
  } catch (err) {
    console.error("배경 제거 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "배경 제거 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

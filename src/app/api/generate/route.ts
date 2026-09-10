import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const replicateApiToken = process.env.REPLICATE_API_TOKEN;

const extractImageUrl = (output: unknown): string => {
  const item = Array.isArray(output) ? output[0] : output;

  if (
    item &&
    typeof item === "object" &&
    "url" in item &&
    typeof (item as { url: unknown }).url === "function"
  ) {
    return String((item as { url: () => unknown }).url());
  }

  return String(item);
};

export async function POST(request: NextRequest) {
  try {
    if (!supabaseUrl || !supabasePublishableKey) {
      return NextResponse.json(
        { error: "서버 설정 오류: Supabase 환경변수가 누락되었습니다." },
        { status: 500 },
      );
    }

    if (!replicateApiToken) {
      return NextResponse.json(
        { error: "서버 설정 오류: Replicate 토큰이 누락되었습니다." },
        { status: 500 },
      );
    }

    // 1. 로그인 여부 확인 (비로그인 사용자의 무단 호출 차단)
    const authHeader = request.headers.get("authorization");
    const accessToken = authHeader?.replace("Bearer ", "");

    if (!accessToken) {
      return NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const supabase = createClient(supabaseUrl, supabasePublishableKey);
    const { data: userData, error: userError } =
      await supabase.auth.getUser(accessToken);

    if (userError || !userData.user) {
      return NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    // 2. 요청 본문에서 프롬프트 검증
    const body = await request.json();
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return NextResponse.json(
        { error: "프롬프트를 입력해주세요." },
        { status: 400 },
      );
    }

    // 3. Replicate(Flux 1.1 Pro)로 이미지 생성 — 품질 정책상 항상 Pro 모델만 사용
    const replicate = new Replicate({ auth: replicateApiToken });
    const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
      input: { prompt },
    });

    const imageUrl = extractImageUrl(output);

    return NextResponse.json({ imageUrl });
  } catch (err) {
    console.error("이미지 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "이미지 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";
import { consumeOneCredit, getQuotaStatus } from "@/lib/credits";

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

// Claude(claude-4.5-haiku, Replicate 경유)는 텍스트를 토큰 조각 배열로 스트리밍 출력한다.
// 배열이면 이어붙이고, 아니면 문자열로 변환한다.
const extractText = (output: unknown): string => {
  if (Array.isArray(output)) {
    return output.join("").trim();
  }
  return String(output).trim();
};

// 사용자의 한글(또는 짧은) 프롬프트를 Flux가 잘 이해하는 상세한 영어 프롬프트로
// 번역·보강한다. Flux 계열 모델은 영어 위주로 학습되어 한글 프롬프트를 그대로 넣으면
// 의도와 무관한 결과가 나오는 문제가 있어 반드시 거쳐야 하는 단계.
// 실패하더라도 전체 생성이 막히지 않도록 원본 프롬프트로 안전하게 대체한다.
const enhancePrompt = async (
  replicate: Replicate,
  originalPrompt: string,
): Promise<string> => {
  try {
    const output = await replicate.run("anthropic/claude-4.5-haiku", {
      input: {
        prompt:
          "Translate and enhance the following image description into a single vivid, detailed English prompt for an AI image generator. Add professional photography terms (lighting, composition, mood) where helpful. Output ONLY the final English prompt with no preamble, no quotes, no explanation.\n\n" +
          `Description: ${originalPrompt}`,
        max_tokens: 1024,
      },
    });

    const enhanced = extractText(output);
    return enhanced || originalPrompt;
  } catch (err) {
    console.error("프롬프트 보강 실패, 원본 프롬프트로 대체:", err);
    return originalPrompt;
  }
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

    // 3. 크레딧/무료 수량 확인 — 하나도 없으면 비싼 API를 호출하기 전에 먼저 차단
    const userId = userData.user.id;
    const quotaBefore = await getQuotaStatus(userId);

    if (quotaBefore.freeRemaining <= 0 && quotaBefore.balance <= 0) {
      return NextResponse.json(
        {
          error:
            "오늘 무료 크레딧을 모두 사용하셨어요. 크레딧을 구매하시거나 내일 다시 시도해주세요.",
        },
        { status: 402 },
      );
    }

    const replicate = new Replicate({ auth: replicateApiToken });

    // 4. 프롬프트 자동 번역·보강 (한글 등 비영어 입력도 Flux가 정확히 이해하도록)
    const enhancedPrompt = await enhancePrompt(replicate, prompt);

    // 5. Replicate(Flux 1.1 Pro)로 이미지 생성 — 품질 정책상 항상 Pro 모델만 사용
    const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
      input: { prompt: enhancedPrompt },
    });

    const imageUrl = extractImageUrl(output);

    // 6. 생성이 실제로 성공했을 때만 크레딧을 차감한다 (실패한 시도는 무료).
    const quotaAfter = await consumeOneCredit(userId);

    return NextResponse.json({ imageUrl, enhancedPrompt, quota: quotaAfter });
  } catch (err) {
    console.error("이미지 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "이미지 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

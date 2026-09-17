import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

// 프롬프트 하나당 몇 장을 동시에 생성할지 (요청 사양: 3~4장)
const IMAGES_PER_REQUEST = 4;

// 최대 실행 시간을 넉넉히 잡아둔다 (번역 호출 + 이미지 4장 동시 생성 +
// 속도 제한에 걸렸을 때의 재시도 대기 시간까지 합치면 기본 10초로는 부족할 수 있음).
export const maxDuration = 60;

// Replicate는 계정당 "한 번에 1개 요청, 그 다음은 몇 초 대기" 식의 순간 속도 제한이
// 있다. 429 응답을 받으면 안내된 대기 시간만큼 기다렸다가 자동으로 재시도한다.
const withRetryOn429 = async <T,>(
  fn: () => Promise<T>,
  retries = 2,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isRateLimited =
      message.includes("429") || message.includes("Too Many Requests");

    if (!isRateLimited || retries <= 0) {
      throw err;
    }

    const match = message.match(/resets in ~?(\d+)s/);
    const waitSeconds = match ? Number(match[1]) : 10;
    console.warn(
      `Replicate 속도 제한 감지, ${waitSeconds}초 대기 후 재시도합니다...`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, (waitSeconds + 1) * 1000),
    );

    return withRetryOn429(fn, retries - 1);
  }
};

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
    const output = await withRetryOn429(() =>
      replicate.run("anthropic/claude-4.5-haiku", {
        input: {
          prompt:
            "Translate and enhance the following image description into a single vivid, detailed English prompt for an AI image generator. Add professional photography terms (lighting, composition, mood) where helpful. Output ONLY the final English prompt with no preamble, no quotes, no explanation.\n\n" +
            `Description: ${originalPrompt}`,
          max_tokens: 1024,
        },
      }),
    );

    const enhanced = extractText(output);
    return enhanced || originalPrompt;
  } catch (err) {
    console.error("프롬프트 보강 실패, 원본 프롬프트로 대체:", err);
    return originalPrompt;
  }
};

// Flux 1.1 Pro로 이미지 1장을 생성한다. 여러 장을 동시에 만들 때 매번 같은
// 결과가 나오지 않도록 매 호출마다 랜덤 시드를 지정한다.
const generateOneImage = async (
  replicate: Replicate,
  prompt: string,
): Promise<string> => {
  const output = await withRetryOn429(() =>
    replicate.run("black-forest-labs/flux-1.1-pro", {
      input: {
        prompt,
        seed: Math.floor(Math.random() * 1_000_000),
      },
    }),
  );

  return extractImageUrl(output);
};

// 개인/초대 전용 도구 — 로그인만 확인하면 크레딧 차감 없이 자유롭게 생성한다.
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
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return NextResponse.json(
        { error: "프롬프트를 입력해주세요." },
        { status: 400 },
      );
    }

    const replicate = new Replicate({ auth: replicateApiToken });

    // 프롬프트 자동 번역·보강 (한글 등 비영어 입력도 Flux가 정확히 이해하도록)
    const enhancedPrompt = await enhancePrompt(replicate, prompt);

    // Flux 1.1 Pro로 이미지 여러 장을 생성 — 품질 정책상 항상 Pro 모델만 사용.
    // Replicate의 "한 번에 1개 요청" 속도 제한 때문에 동시(병렬) 호출이 아니라
    // 하나씩 순차적으로 생성한다.
    const imageUrls: string[] = [];
    for (let i = 0; i < IMAGES_PER_REQUEST; i += 1) {
      imageUrls.push(await generateOneImage(replicate, enhancedPrompt));
    }

    return NextResponse.json({ imageUrls, enhancedPrompt });
  } catch (err) {
    console.error("이미지 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "이미지 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

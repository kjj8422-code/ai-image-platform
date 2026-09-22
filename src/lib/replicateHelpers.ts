import type Replicate from "replicate";

// Replicate는 계정당 "한 번에 1개 요청, 그 다음은 몇 초 대기" 식의 순간 속도 제한이
// 있다. 429 응답을 받으면 안내된 대기 시간만큼 기다렸다가 자동으로 재시도한다.
export const withRetryOn429 = async <T,>(
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

export const extractImageUrl = (output: unknown): string => {
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
export const enhancePrompt = async (
  replicate: Replicate,
  originalPrompt: string,
  instruction = "Translate and enhance the following image description into a single vivid, detailed English prompt for an AI image generator. Add professional photography terms (lighting, composition, mood) where helpful. Output ONLY the final English prompt with no preamble, no quotes, no explanation.",
): Promise<string> => {
  try {
    const output = await withRetryOn429(() =>
      replicate.run("anthropic/claude-4.5-haiku", {
        input: {
          prompt: `${instruction}\n\nDescription: ${originalPrompt}`,
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

export type ThumbnailCopySuggestion = {
  title: string;
  backgroundPrompt: string;
};

// 쇼츠/릴스 썸네일 전용: 한 줄 대본/키워드 하나로 (1) 3~4단어 고CTR 한글 문구와
// (2) 배경 이미지 생성용 영문 프롬프트를 한 번의 호출로 함께 뽑아낸다.
// 배경 프롬프트에는 "얼굴/주요 피사체를 하단 25%·우측 15% 세이프존 밖에 배치하라"는
// 지침을 항상 포함시켜, 쇼츠 UI(제목/버튼)에 가려지지 않는 구도를 유도한다.
const THUMBNAIL_COPY_INSTRUCTION = `You are a YouTube Shorts / Instagram Reels thumbnail copywriter and prompt engineer.
Given a short script or keyword (possibly in Korean), produce two things:
1. "title": a punchy, high-CTR Korean headline of exactly 3 to 4 words (a short phrase, not a full sentence) meant as bold overlay text on a 9:16 thumbnail. Favor curiosity/urgency hooks common in Korean shorts titles.
2. "backgroundPrompt": a single vivid, detailed ENGLISH prompt describing a photographic background scene for this thumbnail (no on-image text, no typography, no captions). Include lighting, composition and mood, and explicitly require that the main subject/face be composed in the upper two-thirds of the frame, roughly centered-left, keeping the bottom quarter and far-right edge of the frame relatively open and uncluttered.
Respond with ONLY a compact JSON object in exactly this shape, no markdown fences, no explanation: {"title": "...", "backgroundPrompt": "..."}`;

export const suggestThumbnailCopy = async (
  replicate: Replicate,
  scriptOrKeyword: string,
): Promise<ThumbnailCopySuggestion> => {
  try {
    const output = await withRetryOn429(() =>
      replicate.run("anthropic/claude-4.5-haiku", {
        input: {
          prompt: `${THUMBNAIL_COPY_INSTRUCTION}\n\nInput: ${scriptOrKeyword}`,
          max_tokens: 512,
        },
      }),
    );

    const raw = extractText(output);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(
      jsonMatch ? jsonMatch[0] : raw,
    ) as Partial<ThumbnailCopySuggestion>;

    if (
      typeof parsed.title === "string" &&
      typeof parsed.backgroundPrompt === "string"
    ) {
      return {
        title: parsed.title.trim(),
        backgroundPrompt: parsed.backgroundPrompt.trim(),
      };
    }
    throw new Error("응답 형식이 예상과 다릅니다.");
  } catch (err) {
    console.error("썸네일 문구 추천 실패, 기본값으로 대체:", err);
    const fallbackTitle = scriptOrKeyword.split(/\s+/).slice(0, 4).join(" ");
    const fallbackPrompt = await enhancePrompt(replicate, scriptOrKeyword);
    return { title: fallbackTitle, backgroundPrompt: fallbackPrompt };
  }
};

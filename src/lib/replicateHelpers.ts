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
// 지침과 "인물이 나오면 항상 한국 여성으로 묘사하라"는 지침을 항상 포함시킨다.
// 문구 톤은 "B급/C급 바이럴 카피라이터" 페르소나로 고정 — 국어책체("~하는 방법",
// "~의 모든 것", "필수 팁") 금지, 3~4단어, 의문문·억울함·반전·밈·모바일 말투(ㅋㅋㅋ/ㄷㄷ/??)
// 를 적극 활용해 스크롤을 멈추게 만드는 게 목표.
//
// 실제로 겪은 문제: few-shot 예시 없이 "3~4단어로 줄여라"는 규칙만 주니 모델이
// 입력 문장을 거의 그대로 title에 복사해버렸다(사용자가 실제 화면에서 확인).
// 아래처럼 "입력 -> 출력" 예시를 직접 보여줘야 "요약"이 아니라 "무관한 반응 문구"를
// 만들어야 한다는 걸 안정적으로 따른다.
const THUMBNAIL_COPY_INSTRUCTION = `You are a 10-year veteran B-grade/C-grade viral copywriter for Instagram Reels and YouTube Shorts — the kind who knows exactly which 3-4 Korean words make a thumb stop scrolling mid-feed.
Given a short script or keyword (possibly in Korean), produce two things:

1. "title": a Korean thumbnail headline of EXACTLY 3 to 4 words (어절), roughly under 14 Korean characters.
   - This is a REACTION/HOOK, NOT a summary. If your title describes what is literally happening in the input, you have failed — invent a punchy reaction a viewer would blurt out instead, even if it doesn't literally describe the scene.
   - NEVER just shorten, paraphrase, or repeat the input sentence. NEVER copy words directly from the input.
   - NEVER use stiff textbook/instructional phrasing such as "~하는 방법", "~의 모든 것", "필수 팁", or any dry how-to/complete-guide tone.
   - Lean hard into questions, indignation/outrage, a twist, meme energy, and deadpan wit — a Korean viewer should react with "어? 진짜?" or "뭔데 이게?", never just nod politely.
   - Naturally sprinkle mobile-native endings like "ㅋㅋㅋ", "ㄷㄷ", or "??" where they actually land — don't force one onto every line, and never let it push past 4 어절.

   Examples (input -> title), follow this transformation style exactly:
   - "퇴근 후 30분 홈트레이닝으로 뱃살 빼는 법" -> "이거 안 하면 손해ㄹㅇ"
   - "백록담에서 등산 오른 여성이 구름을 비닐봉지에 담는 모습" -> "구름 포장 실화냐ㅋㅋㅋ"
   - "신입사원이 첫 출근날 겪은 황당한 실수담" -> "첫 출근에 이게 무슨 일ㄷㄷ"

2. "backgroundPrompt": a single vivid, detailed ENGLISH prompt describing a photographic background scene for this thumbnail (no on-image text, no typography, no captions). Include lighting, composition and mood, and explicitly require that the main subject/face be composed in the upper two-thirds of the frame, roughly centered-left, keeping the bottom quarter and far-right edge of the frame relatively open and uncluttered. If the scene includes any person, ALWAYS explicitly describe that person as a young Korean woman (e.g. "a Korean woman in her 20s") — never leave ethnicity unspecified or default to any other nationality.

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

    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const backgroundPrompt =
      typeof parsed.backgroundPrompt === "string"
        ? parsed.backgroundPrompt.trim()
        : "";

    // 모델이 지침을 무시하고 입력 문장을 그대로(또는 대소문자/공백만 다르게) 베껴
    // 쓴 경우를 실패로 간주한다 — 실제로 이 패턴이 발생했었다(위 주석 참고).
    const isVerbatimEcho =
      title.length > 0 &&
      title.replace(/\s+/g, "") === scriptOrKeyword.trim().replace(/\s+/g, "");

    if (title && backgroundPrompt && !isVerbatimEcho) {
      return { title, backgroundPrompt };
    }
    throw new Error("응답 형식이 예상과 다르거나, 문구가 입력을 그대로 복사했습니다.");
  } catch (err) {
    console.error("썸네일 문구 추천 실패, 기본값으로 대체:", err);
    const fallbackTitle = scriptOrKeyword.split(/\s+/).slice(0, 4).join(" ");
    const fallbackPrompt = await enhancePrompt(replicate, scriptOrKeyword);
    return { title: fallbackTitle, backgroundPrompt: fallbackPrompt };
  }
};

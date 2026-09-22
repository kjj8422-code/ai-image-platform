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
// 문구 톤은 "B급/C급 바이럴 카피라이터" 페르소나로 고정 — 국어책체("~하는 방법",
// "~의 모든 것", "필수 팁") 금지, 3~4단어, 의문문·억울함·반전·밈·모바일 말투(ㅋㅋㅋ/ㄷㄷ/??)
// 를 적극 활용해 스크롤을 멈추게 만드는 게 목표.
//
// 실제로 겪은 문제: few-shot 예시를 넣어도 claude-4.5-haiku가 가끔 입력 문장의
// 앞 4단어를 그대로 잘라 title로 내놓는다(사용자가 실제 화면에서 확인 — 예:
// "백록담에서 등산오른 여성이 구름을 비닐에 담는" -> "백록담에서 등산오른 여성이
// 구름을"). 완전히 같은 문자열만 걸러내는 건 부족해서, "입력 어절을 그대로 이어붙인
// 부분 문자열인가"까지 검사하고, 걸리면 한 번 더 강하게 재지시해서 재시도한다.
// 그래도 실패하면 입력을 잘라 보여주는 대신, 무관한 기본 문구 중 하나로 대체한다
// (어설픈 재탕보다 명백히 "기본값"인 게 낫다).
const THUMBNAIL_COPY_INSTRUCTION = `You are a 10-year veteran B-grade/C-grade viral copywriter for Instagram Reels and YouTube Shorts — the kind who knows exactly which 3-4 Korean words make a thumb stop scrolling mid-feed.
Given a short script or keyword (possibly in Korean), produce two things:

1. "title": a Korean thumbnail headline of EXACTLY 3 to 4 words (어절), roughly under 14 Korean characters.
   - This is a REACTION/HOOK, NOT a summary. If your title describes what is literally happening in the input, you have failed — invent a punchy reaction a viewer would blurt out instead, even if it doesn't literally describe the scene.
   - NEVER just shorten, truncate, paraphrase, or repeat the input sentence. NEVER reuse the input's exact words or word order, even partially — use completely different vocabulary.
   - NEVER use stiff textbook/instructional phrasing such as "~하는 방법", "~의 모든 것", "필수 팁", or any dry how-to/complete-guide tone.
   - Lean hard into questions, indignation/outrage, a twist, meme energy, and deadpan wit — a Korean viewer should react with "어? 진짜?" or "뭔데 이게?", never just nod politely.
   - Naturally sprinkle mobile-native endings like "ㅋㅋㅋ", "ㄷㄷ", or "??" where they actually land — don't force one onto every line, and never let it push past 4 어절.

   Examples (input -> title), follow this transformation style exactly — notice the title shares NO words with the input. These are style references only; never reuse these exact phrases in your answer:
   - "퇴근 후 30분 홈트레이닝으로 뱃살 빼는 법" -> "이거 안 하면 손해ㄹㅇ"
   - "고양이가 냉장고 문 여는 법을 스스로 터득한 영상" -> "이제 아무도 못 막음ㅋㅋ"
   - "신입사원이 첫 출근날 겪은 황당한 실수담" -> "첫 출근에 이게 무슨 일ㄷㄷ"

2. "backgroundPrompt": a single vivid, detailed ENGLISH prompt describing a photographic background scene for this thumbnail (no on-image text, no typography, no captions).
   - First, identify the single most concrete, literal visual detail implied by the input — usually a specific object visibly undergoing the described action. That literal detail MUST be the unmistakable focal point of the image. If the input describes something being captured/held/filled/trapped/glowing inside an object (e.g. "sunset captured in a bottle"), the object itself must visibly show that content glowing/filling/reflecting inside it — do not settle for a generic gesture like merely holding the object up near the phenomenon; the effect must be visibly happening inside or on the object itself.
   - Composition: keep the TOP ~25% of the frame simple and visually calm (plain sky, soft gradient, negative space, no busy detail or raised limbs) because bold title text will be overlaid there. Place the main subject/action in the middle band of the frame (roughly 25%-75% from the top). Keep the bottom 25% and the far-right 15% of the frame relatively open/uncluttered (platform UI covers those areas).
   - Include lighting, composition and mood as professional photography detail (golden hour, depth of field, color grading, etc).
   - If the scene includes any person, ALWAYS explicitly describe that person as a young Korean woman (e.g. "a Korean woman in her 20s") — never leave ethnicity unspecified or default to any other nationality.

Respond with ONLY a compact JSON object in exactly this shape, no markdown fences, no explanation: {"title": "...", "backgroundPrompt": "..."}`;

// 배경 프롬프트에 인물이 등장하면 항상 한국 여성으로 묘사되도록 보장하는 문구.
// 모델이 지침을 놓쳐도(실제로 놓친 적 있음) 최종적으로 Flux에 넘어가는 프롬프트에는
// 반드시 포함되도록, 모델 출력과 무관하게 서버에서 항상 덧붙인다.
const KOREAN_WOMAN_CLAUSE =
  "If any person appears in this scene, that person must be depicted as a young Korean woman in her 20s.";

const withKoreanWomanClause = (prompt: string): string =>
  /korean woman/i.test(prompt) ? prompt : `${prompt} ${KOREAN_WOMAN_CLAUSE}`;

// 뜻은 안 통해도 되니 절대 "입력을 잘라 보여주는" 것보다는 나은, 무관한 기본 문구들.
// 문구 추천이 두 번 다 실패했을 때만 쓰는 최후의 수단이다.
const GENERIC_FALLBACK_TITLES = [
  "이거 실화냐ㅋㅋㅋ",
  "미쳤다 진짜ㄷㄷ",
  "이게 왜 되지??",
  "소름 돋는 반전ㅋㅋ",
];

const wordsOf = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

// title이 입력 문장의 (부분이든 전체든) 연속된 어절을 그대로 이어붙인 것인지 검사한다.
// 완전 일치만 보면 "앞 4단어만 잘라낸" 패턴을 놓치므로 부분 문자열까지 확인한다.
export const looksCopiedFromInput = (title: string, script: string): boolean => {
  const titleWords = wordsOf(title);
  if (titleWords.length === 0) {
    return true;
  }
  const scriptJoined = wordsOf(script).join(" ");
  return scriptJoined.includes(titleWords.join(" "));
};

type RawSuggestion = { title: string; backgroundPrompt: string } | null;

const requestCopyFromModel = async (
  replicate: Replicate,
  scriptOrKeyword: string,
  correctionNote?: string,
): Promise<RawSuggestion> => {
  try {
    const prompt = correctionNote
      ? `${THUMBNAIL_COPY_INSTRUCTION}\n\n${correctionNote}\n\nInput: ${scriptOrKeyword}`
      : `${THUMBNAIL_COPY_INSTRUCTION}\n\nInput: ${scriptOrKeyword}`;

    const output = await withRetryOn429(() =>
      replicate.run("anthropic/claude-4.5-haiku", {
        // claude-4.5-haiku는 Replicate에서 max_tokens >= 1024를 요구한다. 512였을 때는
        // 매번 422로 거부되어 이 함수가 단 한 번도 실제로 성공한 적이 없었고, 항상
        // catch로 빠져 "입력 앞 4단어 자르기" 폴백만 보여주고 있었다(실제로 겪은 버그).
        input: { prompt, max_tokens: 1024 },
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

    return title && backgroundPrompt ? { title, backgroundPrompt } : null;
  } catch (err) {
    console.error("썸네일 문구 추천 호출 실패:", err);
    return null;
  }
};

export const suggestThumbnailCopy = async (
  replicate: Replicate,
  scriptOrKeyword: string,
): Promise<ThumbnailCopySuggestion> => {
  const attempt1 = await requestCopyFromModel(replicate, scriptOrKeyword);
  if (attempt1 && !looksCopiedFromInput(attempt1.title, scriptOrKeyword)) {
    return {
      title: attempt1.title,
      backgroundPrompt: withKoreanWomanClause(attempt1.backgroundPrompt),
    };
  }

  console.warn("문구 추천 1차 시도가 입력을 복사함(또는 실패), 재시도합니다.");
  const attempt2 = await requestCopyFromModel(
    replicate,
    scriptOrKeyword,
    `Your previous attempt ("${attempt1?.title ?? ""}") reused the input's words — that is NOT allowed. Try again with a completely different short reaction phrase that shares no words with the input.`,
  );
  if (attempt2 && !looksCopiedFromInput(attempt2.title, scriptOrKeyword)) {
    return {
      title: attempt2.title,
      backgroundPrompt: withKoreanWomanClause(attempt2.backgroundPrompt),
    };
  }

  console.warn("문구 추천 재시도도 실패, 기본 문구로 대체합니다.");
  const fallbackTitle =
    GENERIC_FALLBACK_TITLES[
      Math.floor(Math.random() * GENERIC_FALLBACK_TITLES.length)
    ];
  const fallbackPrompt = await enhancePrompt(replicate, scriptOrKeyword);
  return {
    title: fallbackTitle,
    backgroundPrompt: withKoreanWomanClause(fallbackPrompt),
  };
};

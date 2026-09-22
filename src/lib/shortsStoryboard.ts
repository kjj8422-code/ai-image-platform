import type Replicate from "replicate";
import { withRetryOn429 } from "@/lib/replicateHelpers";

// 제주도 기반 판타지/B급 바이럴 쇼츠용 스토리보드 생성기.
// 주제 한 줄 -> 6장면 대본 + 장면별 이미지 프롬프트 + SFX/BGM 타임라인을 한 번에 만든다.

export const SCENE_COUNT = 6;

// 효과음은 AI가 파일을 만들 수 없으므로, 실제로 보유한 파일 이름 집합 안에서만
// 고르게 한다. 모델이 마음대로 이름을 지어내면 합성 단계에서 매칭이 전부 실패한다.
export const SFX_LIBRARY = [
  "boom", // 쿵! — 훅, 충격
  "magic", // 샤아아~ — 마법/판타지 순간
  "pop", // 뽁 — 작은 전환
  "whoosh", // 휙 — 빠른 이동/장면 전환
  "suspense", // 두구두구 — 긴장 고조
  "reveal", // 짠! — 반전 공개
  "laugh", // 피식/ㅋㅋ — 코믹 마무리
  "none", // 효과음 없음
] as const;

export type SfxCue = (typeof SFX_LIBRARY)[number];

export const BGM_MOODS = [
  "mystery", // 미스터리/음산
  "epic", // 웅장/반전
  "playful", // 장난스러움/코믹
  "dreamy", // 몽환/판타지
] as const;

export type BgmMood = (typeof BGM_MOODS)[number];

export type StoryboardScene = {
  index: number;
  narration: string;
  imagePrompt: string;
  midjourneyPrompt: string;
  sfx: SfxCue;
  kenBurns: "in" | "out";
};

export type Storyboard = {
  thumbnailCopy: string;
  bgmMood: BgmMood;
  character: string;
  scenes: StoryboardScene[];
};

// 캐릭터 일관성은 모델에게 "매번 똑같이 써라"라고 부탁하지 않는다. 6장면에 걸쳐
// 동일한 문장을 정확히 반복시키는 건 실패하기 쉬워서(이전에 "한국 여성" 지시도
// 무시된 적 있음), 장면별 프롬프트는 상황만 쓰게 하고 외모·의상 시트는 서버가
// 6개 전부에 똑같이 붙인다.
export const DEFAULT_CHARACTER_SHEET =
  "the exact same young Korean woman in her mid-20s in every scene: shoulder-length straight black hair tied in a low ponytail, a mustard-yellow windbreaker over a plain white tee, dark blue jeans, white sneakers, a small brown crossbody bag, light natural makeup, round friendly face";

// 6장면 모두에 동일하게 적용되는 촬영/구도 규칙. 자막과 플랫폼 UI 자리를 비워둔다.
const SHARED_STYLE_SHEET =
  "cinematic photorealistic still, vertical 9:16 composition, 35mm lens, natural cinematic color grading, " +
  "keep the top 25% of the frame visually calm and uncluttered for overlaid title text, " +
  "place the subject and main action in the middle band of the frame, " +
  "keep the bottom 25% and the far-right 15% of the frame free of important detail";

const buildInstruction = (topic: string, character: string): string => `You are a 10-year veteran B-grade/C-grade viral short-form writer for Korean YouTube Shorts and Instagram Reels, working on a Jeju-island fantasy series. You write the kind of 썰 (story) narration that makes someone stop scrolling and mutter "어? 이거 진짜인가?".

Write a ${SCENE_COUNT}-scene short-form video (15~30 seconds total) about this topic:
"${topic}"

Rules for "narration" (Korean, one line per scene):
- 썰체/구어체 only. Talk like you're telling a friend something unbelievable that just happened to you.
- NEVER use stiff narration or textbook phrasing ("~하는 방법", "~의 모든 것", "오늘은 ~에 대해 알아보겠습니다"). If it sounds like a documentary or a blog intro, rewrite it.
- Use wit, provocation, mock-outrage, and 억울함. Endings like "ㅋㅋㅋ", "ㄷㄷ", "??", "아니 진짜로" are welcome where they land naturally.
- Scene 1 must be a hook that makes stopping unavoidable. Scene 6 must land a twist, a punchline, or a "그래서 어떻게 됐냐면" cliffhanger.
- Each scene's narration should be about 2 to 4 seconds when read aloud (roughly 10~25 Korean characters). Keep the whole thing under 30 seconds.

Rules for "imagePrompt" (English, one per scene):
- Describe ONLY what is happening in that scene: the action, the Jeju location, the time of day, the light, the camera angle. Do NOT describe the character's appearance, clothes, or hair — that is added separately and must not be repeated.
- Make the single most concrete visual of that scene unmistakable. If something magical or impossible is happening, the image must literally show it happening, not merely hint at it.
- Ground it in real Jeju scenery (한라산, 백록담, 성산일출봉, 주상절리, 돌하르방, 검은 현무암 해변, 유채꽈밭, 감귤밭, 해녀, 오름) where it fits the story.

Rules for "sfx": pick exactly one cue name per scene from this fixed list — ${SFX_LIBRARY.join(", ")}. Use "none" when silence serves the scene better. Scene 1 should usually be "boom" or "suspense", and the twist scene should usually be "reveal" or "laugh".

Rules for "kenBurns": "in" (slow zoom in, for tension/focus) or "out" (slow zoom out, for reveals/scale). Alternate so consecutive scenes don't feel identical.

Also produce:
- "thumbnailCopy": a 3 to 4 word Korean thumbnail headline in the same B-grade voice. A reaction/hook, never a summary, and it must not copy words from the topic.
- "bgmMood": exactly one of ${BGM_MOODS.join(", ")}.

Respond with ONLY a compact JSON object in exactly this shape, no markdown fences, no explanation:
{"thumbnailCopy":"...","bgmMood":"...","scenes":[{"index":1,"narration":"...","imagePrompt":"...","sfx":"...","kenBurns":"in"}, ... ${SCENE_COUNT} scenes total]}

The character description that will be appended to every scene (do not repeat it yourself): ${character}`;

const extractText = (output: unknown): string => {
  if (Array.isArray(output)) {
    return output.join("").trim();
  }
  return String(output).trim();
};

const isSfxCue = (value: unknown): value is SfxCue =>
  typeof value === "string" && (SFX_LIBRARY as readonly string[]).includes(value);

const isBgmMood = (value: unknown): value is BgmMood =>
  typeof value === "string" && (BGM_MOODS as readonly string[]).includes(value);

type RawScene = {
  index?: unknown;
  narration?: unknown;
  imagePrompt?: unknown;
  sfx?: unknown;
  kenBurns?: unknown;
};

// 장면 프롬프트에 캐릭터 시트와 공통 스타일을 서버에서 직접 붙인다.
// 이게 6장면 캐릭터 일관성을 보장하는 핵심이다.
const buildScenePrompts = (
  scenePrompt: string,
  character: string,
): { imagePrompt: string; midjourneyPrompt: string } => {
  const full = `${scenePrompt.trim()} Featuring ${character}. ${SHARED_STYLE_SHEET}.`;
  return {
    imagePrompt: full,
    // Midjourney는 비율을 파라미터로 받는다. Flux/DALL-E용은 위의 imagePrompt를 쓰면 된다.
    midjourneyPrompt: `${full} --ar 9:16 --style raw`,
  };
};

const parseStoryboard = (
  raw: string,
  character: string,
): Storyboard | null => {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  let parsed: {
    thumbnailCopy?: unknown;
    bgmMood?: unknown;
    scenes?: unknown;
  };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  const rawScenes = Array.isArray(parsed.scenes) ? (parsed.scenes as RawScene[]) : [];
  if (rawScenes.length !== SCENE_COUNT) {
    return null;
  }

  const scenes: StoryboardScene[] = [];
  for (const [position, rawScene] of rawScenes.entries()) {
    const narration =
      typeof rawScene.narration === "string" ? rawScene.narration.trim() : "";
    const scenePrompt =
      typeof rawScene.imagePrompt === "string" ? rawScene.imagePrompt.trim() : "";
    if (!narration || !scenePrompt) {
      return null;
    }

    scenes.push({
      index: position + 1,
      narration,
      ...buildScenePrompts(scenePrompt, character),
      sfx: isSfxCue(rawScene.sfx) ? rawScene.sfx : "none",
      kenBurns: rawScene.kenBurns === "out" ? "out" : "in",
    });
  }

  const thumbnailCopy =
    typeof parsed.thumbnailCopy === "string" && parsed.thumbnailCopy.trim()
      ? parsed.thumbnailCopy.trim()
      : scenes[0].narration.slice(0, 14);

  return {
    thumbnailCopy,
    bgmMood: isBgmMood(parsed.bgmMood) ? parsed.bgmMood : "mystery",
    character,
    scenes,
  };
};

export const generateStoryboard = async (
  replicate: Replicate,
  topic: string,
  character: string = DEFAULT_CHARACTER_SHEET,
): Promise<Storyboard> => {
  const instruction = buildInstruction(topic, character);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const output = await withRetryOn429(() =>
        replicate.run("anthropic/claude-4.5-haiku", {
          // 이 모델은 Replicate에서 max_tokens >= 1024를 요구한다. 6장면 JSON은
          // 길어서 넉넉히 준다.
          input: { prompt: instruction, max_tokens: 4096 },
        }),
      );

      const storyboard = parseStoryboard(extractText(output), character);
      if (storyboard) {
        return storyboard;
      }
      console.warn(`스토리보드 파싱 실패 (시도 ${attempt}/2), 재시도합니다.`);
    } catch (err) {
      console.error(`스토리보드 생성 실패 (시도 ${attempt}/2):`, err);
    }
  }

  throw new Error(
    "스토리보드를 생성하지 못했습니다. 주제를 조금 더 구체적으로 적어 다시 시도해주세요.",
  );
};

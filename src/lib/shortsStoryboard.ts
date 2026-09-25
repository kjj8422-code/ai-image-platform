import type Replicate from "replicate";
import { AUDIO_DIRECTION, directGeneratedAudio, type SfxTiming } from "./audioDirection.ts";
import { withRetryOn429 } from "./replicateHelpers.ts";
import {
  AI_BGM_MOODS,
  AI_SFX_CUES,
  BGM_MOODS,
  SFX_LIBRARY,
  aiBgmMenu,
  aiSfxMenu,
  type BgmMood,
  type SfxCue,
} from "./audioCatalog.ts";

// 제주도 기반 판타지/B급 바이럴 쇼츠용 스토리보드 생성기.
// 주제 한 줄 -> 6장면 대본 + 장면별 이미지 프롬프트 + SFX/BGM 타임라인을 한 번에 만든다.

export const SCENE_COUNT = 6;

// 효과음은 AI가 파일을 만들 수 없으므로, 실제로 보유한 파일 이름 집합 안에서만
// 고르게 한다. 모델이 마음대로 이름을 지어내면 합성 단계에서 매칭이 전부 실패한다.
// 목록 자체는 audioCatalog.json에 있다(웹과 PC 합성기가 같이 읽는다).
export { BGM_MOODS, SFX_LIBRARY, type BgmMood, type SfxCue };

export type StoryboardScene = {
  index: number;
  narration: string;
  imagePrompt: string;
  midjourneyPrompt: string;
  sfx: SfxCue;
  sfxTiming?: SfxTiming;
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
- 각 장면 나레이션은 소리 내어 읽었을 때 2~4초, 공백을 뺀 한글 10~25자다. 한 장면에 문장을 두 개 넣지 마라. 넘치면 그건 다음 장면으로 쪼개라.

【이야기 뼈대】 ${SCENE_COUNT}개 장면을 이 흐름으로 짜라.
- 첫 장면: 훅. 결과나 제일 이상한 장면을 먼저 던져라. 배경 설명으로 시작하면 그 자리에서 넘긴다.
- 중간: 한 장면에 새 정보 하나씩. 장면이 끝날 때마다 "그래서 어떻게 됐는데?" 가 남아야 한다.
- 뒤에서 두세 번째: 시청자가 속으로 품을 의심을 네가 먼저 말해라. ("이거 편집 아니냐고?")
- 마지막 직전: 반전. 앞에서 깔아둔 게 뒤집힌다. 여기가 제일 세야 한다.
- 마지막: 한 줄로 툭 끝낸다. 교훈이나 정리는 절대 쓰지 마라.

【허접해 보이지 않으려면】
- "아름다운", "환상적인", "신비로운" 같은 형용사를 쓰지 마라. 무슨 일이 벌어졌는지만 말해라. 감상은 보는 사람이 한다.
- 두루뭉술한 말 대신 숫자와 구체적인 것을 넣어라. "한참" 대신 "세 시간째", "많이" 대신 "네 번".
- 물건이 등장하면 "뭔가", "이상한 거" 같이 얼버무리지 말고 한 번 이름을 정한 뒤 끝까지 같은 이름으로 불러라. 얼버무리면 장면마다 다른 물건이 그려져서 이야기가 깨진다.
- 자랑하지 마라. 당황하고, 억울해하고, 실패해라. 일이 잘 풀리는 얘기는 아무도 안 본다.

【말이 이어지게】 나레이션 전체가 한 사람이 쉬지 않고 말하는 한 덩어리로 들려야 한다. 단 이어붙이는 방법을 줄마다 바꿔라. 같은 방법을 반복하면 억지로 갖다 붙인 티가 난다. 아래를 섞어 써라:
- 연결어미로 넘기기 — "~했는데", "~더니", "~다가", "~길래"
- 다음 줄이 접속사로 받기 — "근데", "그래서", "아니 근데", "심지어", "결국"
- 질문 던지고 다음 줄에서 답하기 — "이게 말이 되냐?" 다음 줄 "되더라고"
- 짧게 툭 끊고 다음 줄이 이어받기 — "근데 안 꺼짐." 다음 줄 "세 시간째."
- 앞줄의 단어를 다음 줄 첫머리에서 다시 받기
딱 끝맺는 건 마지막 장면 하나뿐이다.

【리듬】 전부 비슷한 길이면 읽을 때 리듬이 죽어서 기계가 읽는 것처럼 들린다. 숫자로 지킬 것:
- 공백을 뺀 글자 수로 셌을 때, 가장 짧은 줄은 8자 이하여야 한다.
- 가장 긴 줄은 20자 이상, 25자 이하여야 한다. 즉 차이가 12자 이상이어야 한다. 모든 줄이 10~15자 언저리로 고르게 나오면 그건 실패이고, 30자를 넘는 줄이 있어도 실패다.
- 8자 이하인 짧은 줄은 반전 직전이나 직후에 놓으면 제일 세게 꽂힌다.

【톤이 살아나게】 이 대본은 기계 음성이 소리 내어 읽는다. 문장부호와 감탄사가 없으면 전부 같은 높이로 읽어서 감정 없는 안내방송처럼 들린다:
- 물음표(?)가 들어간 줄이 최소 하나 — 의심하거나 되묻는 장면
- 느낌표(!)가 들어간 줄이 최소 하나 — 반전이나 놀라는 장면
- 말줄임표(...)로 뜸 들이는 줄이 하나 — 긴장을 끄는 장면
- 감탄사로 시작하는 줄이 최소 둘 — "헐", "아니", "와", "야", "잠깐", "어?" 아끼지 마라.

【자가검사】 다 쓰고 나서 줄 끝 두 글자만 세로로 읽어봐라. 같은 게 두 번 나오면 그 대본은 버리고 처음부터 다시 써라.

Rules for "imagePrompt" (English, one per scene):
- Describe ONLY what is happening in that scene: the action, the Jeju location, the time of day, the light, the camera angle. Do NOT describe the character's appearance, clothes, or hair — that is added separately and must not be repeated.
- 앞 장면에 나온 물건이 이 장면에도 나온다면, 그 물건을 새로 상상하지 말고 propSheet에 적은 그대로 두어라. 장면마다 다른 물건이 나오면 이야기가 거기서 끊긴다.
- Make the single most concrete visual of that scene unmistakable. If something magical or impossible is happening, the image must literally show it happening, not merely hint at it.
- Ground it in real Jeju scenery (한라산, 백록담, 성산일출봉, 주상절리, 돌하르방, 검은 현무암 해변, 유채꽈밭, 감귤밭, 해녀, 오름) where it fits the story.

Rules for "sfx": pick exactly one cue name per scene from this fixed list — ${aiSfxMenu()}. Use "none" when silence serves the scene better.
${AUDIO_DIRECTION}

Rules for "kenBurns": "in" (slow zoom in, for tension/focus) or "out" (slow zoom out, for reveals/scale). Alternate so consecutive scenes don't feel identical.

Also produce:
- "propSheet": 이야기가 따라가는 핵심 물건 하나의 생김새를, 장면 어디에 나와도 같은 물건으로 알아볼 수 있을 만큼 구체적인 영어 한 줄로 적어라. 색, 재질, 크기, 형태, 표면의 특징을 넣어라. (예: "a fist-sized smooth black volcanic stone with a glowing amber crack running across it") 이야기에 물건이 없으면 빈 문자열.
- "thumbnailCopy": a 3 to 4 word Korean thumbnail headline in the same B-grade voice. A reaction/hook, never a summary, and it must not copy words from the topic.
- "bgmMood": exactly one of ${aiBgmMenu()} (write only the name).

Respond with ONLY a compact JSON object in exactly this shape, no markdown fences, no explanation:
{"thumbnailCopy":"...","propSheet":"...","bgmMood":"...","scenes":[{"index":1,"narration":"...","imagePrompt":"...","sfx":"...","sfxTiming":"start","kenBurns":"in"}, ... ${SCENE_COUNT} scenes total]}

The character description that will be appended to every scene (do not repeat it yourself): ${character}`;

const extractText = (output: unknown): string => {
  if (Array.isArray(output)) {
    return output.join("").trim();
  }
  return String(output).trim();
};

// AI가 고른 값은 AI에게 보여준 칸 안에서만 받는다. "내 효과음" 같은 칸은 PC에
// 파일이 없을 수 있어서, 거기로 새면 그 장면 소리가 빠진다.
const isSfxCue = (value: unknown): value is SfxCue =>
  typeof value === "string" && (AI_SFX_CUES as readonly string[]).includes(value);

const isBgmMood = (value: unknown): value is BgmMood =>
  typeof value === "string" && (AI_BGM_MOODS as readonly string[]).includes(value);

type RawScene = {
  index?: unknown;
  narration?: unknown;
  imagePrompt?: unknown;
  sfx?: unknown;
  sfxTiming?: unknown;
  kenBurns?: unknown;
};

// 장면 프롬프트에 캐릭터 시트와 공통 스타일을 서버에서 직접 붙인다.
// 이게 6장면 캐릭터 일관성을 보장하는 핵심이다.
const buildScenePrompts = (
  scenePrompt: string,
  character: string,
  prop: string,
): { imagePrompt: string; midjourneyPrompt: string } => {
  // 이야기가 한 물건을 따라가는데 장면마다 다른 물건이 그려지면, 1~2장면에서 잡은
  // 호기심이 3장면에서 그대로 깨진다(반짝이던 것이 갑자기 나침반이 되는 식).
  // 외모 시트로 인물을 붙잡아둔 것과 똑같이, 그 물건의 생김새도 장면마다 붙인다.
  const propLine = prop ? ` The object in the story is always ${prop}.` : "";
  const full = `${scenePrompt.trim()} Featuring ${character}.${propLine} ${SHARED_STYLE_SHEET}.`;
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
    propSheet?: unknown;
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
  const propSheet =
    typeof parsed.propSheet === "string" ? parsed.propSheet.trim() : "";

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
      ...buildScenePrompts(scenePrompt, character, propSheet),
      sfx: isSfxCue(rawScene.sfx) ? rawScene.sfx : "none",
      sfxTiming: rawScene.sfxTiming === "middle" || rawScene.sfxTiming === "end" ? rawScene.sfxTiming : "start",
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
    scenes: directGeneratedAudio(scenes),
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

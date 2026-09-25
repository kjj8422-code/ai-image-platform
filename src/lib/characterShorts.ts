import type Replicate from "replicate";
import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { withRetryOn429, extractImageUrl } from "@/lib/replicateHelpers";
import { AI_SFX_CUES, aiSfxMenu, type SfxCue } from "@/lib/audioCatalog";

// "사진 1장으로 캐릭터 고정 + 내가 쓴 대본으로 장면 생성" 기능.
// AI 영상 쇼츠(실제 사진을 그대로 영상으로 움직임)나 사진 쇼츠(실제 사진 그대로 Ken
// Burns)와 달리, 여기는 기준 사진 1장을 "이 생김새로 그려달라"는 근거로만 쓰고
// 장면마다 완전히 새 이미지를 그린다(flux-kontext-pro). 대본은 사용자가 직접
// 쓰므로 Claude는 "장면 묘사 번역 + 효과음 선택"만 한다 — shortsFromImages.ts처럼
// 대본 자체를 새로 쓰지 않는다.

export type SceneStyle = "comic" | "jeju_travel" | "emotional" | "product_ad";

export const STYLE_LABEL: Record<SceneStyle, string> = {
  comic: "코믹 썰 (B급/C급 바이럴 톤)",
  jeju_travel: "제주 여행 소개 (밝은 톤)",
  emotional: "감성 영상 (잔잔한 톤)",
  product_ad: "제품 광고 (설득적인 톤)",
};

// 그림체·구도 가이드. 스타일마다 톤이 다르므로 프롬프트 크래프팅에 그대로 넣는다.
const STYLE_VISUAL_GUIDE: Record<SceneStyle, string> = {
  comic: "playful, slightly exaggerated expression and pose, vivid saturated colors, comedic timing",
  jeju_travel: "bright natural daylight, real Jeju scenery in the background (basalt rock, tangerine fields, coastline), travel-photo feel",
  emotional: "soft cinematic lighting, gentle natural pose, muted warm color grading",
  product_ad: "clean composition, the subject and any object clearly in focus, commercial-photo lighting",
};

export const SCENE_MIN = 2;
export const SCENE_MAX = 10;
export const SCENE_DURATION_SECONDS = 5;

// 장면 하나당 Replicate를 2번 부른다(Haiku 프롬프트 크래프팅 + Flux 이미지). 계정
// 크레딧이 $5 미만이면 Replicate가 "분당 6회, 버스트 1회"로 강하게 제한한다 — 실제로
// 6장면 연속 생성 중 429로 실패하는 걸 확인했다(기본 재시도 2회로는 부족했음).
// withRetryOn429는 안내된 대기 시간을 그대로 지키므로, 횟수만 넉넉히 늘려준다.
const RATE_LIMIT_RETRIES = 6;

const SHARED_FRAMING =
  "vertical 9:16 composition, keep the top 25% of the frame visually calm and uncluttered for overlaid title text, " +
  "place the subject and main action in the middle band of the frame, keep the bottom 25% and the far-right 15% free of important detail.";

// "outfit"까지 고정하면 "모자가 날아간다" 같은 장면 지시를 무시하고 모자를 계속
// 그리는 문제가 실제로 있었다(사용자가 확인) — 정체성은 종/얼굴/체형/털색·무늬처럼
// "다른 개체로 보이면 안 되는 것"만 고정하고, 자세·행동·소품·의상은 장면 지시가
// 우선하도록 명시한다.
const IDENTITY_LOCK =
  "Keep the exact same individual as in the reference photo — same species, face, body shape, and fur/skin coloring and markings, so it's unmistakably the same character. " +
  "Its pose, action, background, and any accessories or props (hats, clothing, held objects) MUST follow the scene description below exactly, even if that means an accessory is now missing, damaged, or different from the reference photo — the scene description always overrides what's in the reference photo for anything except the core identity traits just listed.";

type CraftedScene = { imagePrompt: string; sfx: SfxCue };

const isSfxCue = (value: unknown): value is SfxCue =>
  typeof value === "string" && (AI_SFX_CUES as readonly string[]).includes(value);

const extractText = (output: unknown): string =>
  Array.isArray(output) ? output.join("").trim() : String(output).trim();

// 사용자가 쓴 한국어 나레이션 한 줄 -> flux-kontext-pro에 보낼 영어 편집 지시문 +
// 이 장면에 어울리는 효과음. Claude 직접 호출(ANTHROPIC_API_KEY) 대신 이미 이 기능에
// 필수인 Replicate 토큰으로 claude-4.5-haiku를 호출한다 — 별도 키를 요구하지 않기 위함
// (replicateHelpers.ts의 enhancePrompt/suggestThumbnailCopy와 같은 방식).
export const craftScenePrompt = async (
  replicate: Replicate,
  narration: string,
  style: SceneStyle,
  sceneIndex: number,
  totalScenes: number,
  previousSummary?: string,
): Promise<CraftedScene> => {
  const continuityNote = previousSummary?.trim()
    ? `\nStory so far (previous episodes, for context only — do not redraw past scenes, just stay consistent with it): "${previousSummary.trim()}"\nDo not contradict this or re-introduce already-established objects/settings differently.\n`
    : "";

  const instruction = `You are crafting an image-editing instruction for flux-kontext-pro, which takes ONE reference photo and redraws it into a new scene while keeping the same subject.

Scene ${sceneIndex} of ${totalScenes}. Style: ${STYLE_LABEL[style]}.
${continuityNote}Korean narration line for this scene (what's being said while this image is on screen): "${narration}"

Write:
1. "imagePrompt": a single English instruction telling flux-kontext-pro what new scene/action/pose to draw, grounded in what the narration literally describes (don't invent unrelated details). If the narration implies something CHANGED from a default/reference state — an item flying away, being lost, broken, put on, taken off, appearing, disappearing — say so explicitly and unambiguously (e.g. "its hat is gone, blown away and visible flying off in the background" rather than just "looking startled"), since the model defaults to keeping the reference photo's details unless clearly told otherwise. Visual style: ${STYLE_VISUAL_GUIDE[style]}. ${SHARED_FRAMING}
2. "sfx": exactly one of these cues (sound described in parentheses): ${aiSfxMenu()} — that fits this scene's mood. Use "none" if silence is better.

Respond with ONLY a compact JSON object, no markdown fences, no explanation: {"imagePrompt": "...", "sfx": "..."}`;

  try {
    const output = await withRetryOn429(
      () =>
        replicate.run("anthropic/claude-4.5-haiku", {
          input: { prompt: instruction, max_tokens: 1024 },
        }),
      RATE_LIMIT_RETRIES,
    );
    const raw = extractText(output);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as {
      imagePrompt?: unknown;
      sfx?: unknown;
    };
    const imagePrompt =
      typeof parsed.imagePrompt === "string" && parsed.imagePrompt.trim()
        ? parsed.imagePrompt.trim()
        : null;
    if (!imagePrompt) throw new Error("imagePrompt 누락");
    return {
      imagePrompt: `${IDENTITY_LOCK} ${imagePrompt}`,
      sfx: isSfxCue(parsed.sfx) ? parsed.sfx : "none",
    };
  } catch (err) {
    console.error("장면 프롬프트 크래프팅 실패, 나레이션을 그대로 사용합니다:", err);
    return {
      imagePrompt: `${IDENTITY_LOCK} Depict this moment: ${narration}. ${SHARED_FRAMING}`,
      sfx: "none",
    };
  }
};

export type CharacterImageResult = { providerRawUrl: string; costCents: number };

export interface CharacterImageProvider {
  readonly name: string;
  estimateCostCents(): number;
  generate(input: { referenceImageUrl: string; prompt: string }): Promise<CharacterImageResult>;
}

// 파이프라인을 비용 없이 끝까지 테스트하기 위한 가짜 구현. 기준 사진을 그대로
// 돌려준다(진짜처럼 매번 다른 그림이 나오진 않지만, 장면 수·나레이션·순서 확인엔 충분).
export class MockCharacterImageProvider implements CharacterImageProvider {
  readonly name = "mock";
  estimateCostCents(): number {
    return 0;
  }
  async generate(input: { referenceImageUrl: string }): Promise<CharacterImageResult> {
    return { providerRawUrl: input.referenceImageUrl, costCents: 0 };
  }
}

export const REAL_CHARACTER_PROVIDER_NAME = "flux-kontext-pro";

// 실제 공급자 — 비용이 든다(REPLICATE_API_TOKEN, $0.04/장). CLAUDE.md 규칙: 사용자의
// 명시적 승인 없이 호출부가 이 클래스를 선택하지 않는다(요청마다 provider:"real"을
// 명시해야 함 — src/app/api/shorts/character/scene/route.ts 참고).
export class RealCharacterImageProvider implements CharacterImageProvider {
  readonly name = REAL_CHARACTER_PROVIDER_NAME;
  private readonly replicate: Replicate;

  constructor(replicate: Replicate) {
    this.replicate = replicate;
  }

  estimateCostCents(): number {
    return 4; // https://replicate.com/black-forest-labs/flux-kontext-pro — $0.04 / output image
  }

  async generate(input: { referenceImageUrl: string; prompt: string }): Promise<CharacterImageResult> {
    const output = await withRetryOn429(
      () =>
        this.replicate.run("black-forest-labs/flux-kontext-pro", {
          input: {
            prompt: input.prompt,
            input_image: input.referenceImageUrl,
            aspect_ratio: "9:16",
            output_format: "png",
            safety_tolerance: 2,
          },
        }),
      RATE_LIMIT_RETRIES,
    );
    return { providerRawUrl: extractImageUrl(output), costCents: this.estimateCostCents() };
  }
}

export const getCharacterImageProvider = (
  name: "mock" | "real",
  replicate: Replicate,
): CharacterImageProvider =>
  name === "real" ? new RealCharacterImageProvider(replicate) : new MockCharacterImageProvider();

// 공급자 임시 URL을 우리 Storage로 옮겨 영구 URL로 바꾼다(videoStorage.ts의
// persistVideoClip과 같은 이유 — Replicate 출력 URL은 오래 보장되지 않는다).
// mock은 이미 우리 Storage에 있는 기준 사진 URL을 그대로 돌려주므로 옮길 필요가 없다.
export const persistCharacterSceneImage = async (
  userId: string,
  sceneKey: string,
  providerRawUrl: string,
): Promise<string> => {
  const response = await fetch(providerRawUrl);
  if (!response.ok) {
    throw new Error("생성된 이미지를 가져오지 못했습니다.");
  }
  const contentType = response.headers.get("content-type") ?? "image/png";
  const extension = contentType.includes("webp") ? "webp" : contentType.includes("jpeg") ? "jpg" : "png";
  const bytes = await response.arrayBuffer();
  const path = `${userId}/character-scenes/${sceneKey}-${randomUUID()}.${extension}`;

  const supabaseAdmin = getSupabaseAdmin();
  const { error: uploadError } = await supabaseAdmin.storage
    .from("gallery")
    .upload(path, Buffer.from(bytes), { contentType, upsert: false });
  if (uploadError) throw uploadError;

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from("gallery").getPublicUrl(path);
  return publicUrl;
};

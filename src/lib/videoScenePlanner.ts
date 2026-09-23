import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { VideoStyle } from "@/lib/videoJobs";

// 업로드된 이미지들을 "영상 장면 계획"으로 바꾼다 — 사진 쇼츠(shortsFromImages.ts)와
// 달리 각 장면에 핵심 동작·카메라 움직임·유지할 외형까지 정해야 영상 생성 API에
// 쓸 수 있는 프롬프트가 나온다.
//
// 계획(Planner)과 공급자(VideoProvider)를 같은 이유로 인터페이스로 분리했다: 실제
// Claude 호출은 돈이 든다(ANTHROPIC_API_KEY). 승인 없이 실제로 호출하지 않도록,
// 기본은 항상 MockScenePlanner다(getDefaultScenePlannerName).

export type ScenePlan = {
  imageIndex: number; // 1부터, 올린 순서 기준
  narration: string;
  subtitle: string;
  keyAction: string;
  cameraMotion: string;
  preserveNotes: string;
  prompt: string;
};

export type PlanResult = {
  scenes: ScenePlan[];
};

export type PlanOptions = {
  keepOrder: boolean;
  useAllImages: boolean;
  style: VideoStyle;
  narrationEnabled: boolean;
  subtitleEnabled: boolean;
};

export interface ScenePlanner {
  readonly name: string;
  plan(imageUrls: string[], options: PlanOptions): Promise<PlanResult>;
}

// 장면 수 기준. 5초 장면 기준 6개면 30초에 가장 가깝다. 최종 편집(자막/음악 합성)
// 단계에서 실측 나레이션 길이에 맞춰 조정하는 건 후속 범위(2단계) 작업이다.
export const TARGET_SCENE_COUNT = 6;
export const MIN_SCENE_COUNT = 5;
export const MAX_SCENE_COUNT = 7;
export const SCENE_DURATION_SECONDS = 5;

const STYLE_LABEL: Record<VideoStyle, string> = {
  comic: "코믹 썰 (B급/C급 바이럴 톤, 반전 있는 이야기)",
  jeju_travel: "제주 여행 소개 (장소·경험을 소개하는 밝은 톤)",
  emotional: "감성 영상 (잔잔하고 진솔한 톤)",
  product_ad: "제품 광고 (제품의 매력을 보여주는 설득적인 톤)",
};

// 실제 공급자 연결 전, 파이프라인(job 생성 -> 장면 생성 -> 상태 조회 -> 미리보기)을
// 끝까지 테스트하기 위한 가짜 구현. 비용이 전혀 들지 않고, 업로드 순서/옵션을
// 그대로 지킨다(keepOrder, useAllImages 검증에도 그대로 쓸 수 있게).
export class MockScenePlanner implements ScenePlanner {
  readonly name = "mock";

  async plan(imageUrls: string[], options: PlanOptions): Promise<PlanResult> {
    const count = options.useAllImages
      ? imageUrls.length
      : Math.min(imageUrls.length, TARGET_SCENE_COUNT);

    const indices = Array.from({ length: count }, (_, i) => i + 1);
    // useAllImages가 아니면(=AI가 고를 수 있으면) 모의 구현도 "골랐다"는 걸 보여주려고
    // keepOrder가 꺼져 있을 때만 순서를 살짝 섞는다. keepOrder가 켜져 있으면 절대 안 섞는다.
    const order =
      !options.keepOrder && !options.useAllImages
        ? [...indices].reverse()
        : indices;

    return {
      scenes: order.map((imageIndex, i) => ({
        imageIndex,
        narration: options.narrationEnabled
          ? `(모의) ${i + 1}번째 장면 나레이션입니다.`
          : "",
        subtitle: options.subtitleEnabled ? `(모의) 장면 ${i + 1}` : "",
        keyAction: "피사체가 자연스럽게 움직인다 (모의 데이터)",
        cameraMotion: i % 2 === 0 ? "천천히 줌인" : "천천히 줌아웃",
        preserveNotes: "얼굴·의상·소품 형태 유지 (모의 데이터)",
        prompt: `mock prompt for scene ${i + 1}`,
      })),
    };
  }
}

// 응답 형식을 정규식으로 긁어 파싱하면 모델이 형식을 어겼을 때 조용히 깨진다.
// 구조화 출력(Zod)으로 스키마를 강제해 그 실패 경로 자체를 없앤다.
const SceneSchema = z.object({
  imageIndex: z
    .number()
    .int()
    .describe("이 장면에 쓸 사진 번호. 올린 순서대로 1부터 센다"),
  narration: z.string().describe("이 장면의 한국어 나레이션 한 줄 (2~4초 분량)"),
  subtitle: z.string().describe("화면에 표시할 한국어 자막 (나레이션과 같아도 됨)"),
  keyAction: z
    .string()
    .describe(
      "이 장면에서 일어나는 단 하나의 핵심 동작을 영어로 한 문장. 복잡한 연속 동작을 넣지 말 것",
    ),
  cameraMotion: z
    .string()
    .describe("카메라 움직임 영어 한 문장 (예: slow zoom in, static shot, slow pan left)"),
  preserveNotes: z
    .string()
    .describe("유지해야 할 인물 얼굴·체형·의상·소품·색상을 영어로 구체적으로"),
});

const PlanSchema = z.object({
  imageOrder: z
    .array(z.number().int())
    .describe(
      "실제로 쓸 사진 번호를 이야기 순서대로. useAllImages가 true면 모든 사진 번호가 정확히 " +
        "한 번씩 나와야 하고, keepOrder가 true면 올린 순서와 동일해야 한다",
    ),
  scenes: z.array(SceneSchema),
});

// 모델이 나눠 준 keyAction/cameraMotion/preserveNotes를 영상 생성 공급자에 보낼
// 프롬프트 한 줄로 조립한다. 모델에게 처음부터 완성된 프롬프트 문장을 맡기지 않고
// 여기서 조립하는 이유: 세 항목을 각각 검증·재사용(로그, 재생성 시 비교)할 수 있고,
// 조립 형식을 한 곳에서만 바꾸면 되기 때문이다(shortsStoryboard.ts의 buildScenePrompts와 같은 이유).
const composeVideoPrompt = (scene: z.infer<typeof SceneSchema>): string =>
  `${scene.keyAction}. Camera: ${scene.cameraMotion}. Keep unchanged: ${scene.preserveNotes}.`;

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      "서버 설정 오류: ANTHROPIC_API_KEY가 없습니다. console.anthropic.com에서 키를 " +
        "발급받아 환경변수로 등록해주세요.",
    );
  }
}

const buildInstruction = (imageCount: number, options: PlanOptions): string => {
  const countRule = options.useAllImages
    ? `사진 ${imageCount}장을 전부 정확히 한 번씩 써서 ${imageCount}개 장면을 만들어라. 하나도 버리지 마라.`
    : `사진 중 하나의 이야기로 묶이는 것만 골라 ${MIN_SCENE_COUNT}~${MAX_SCENE_COUNT}개 장면을 만들어라. ` +
      `어울리지 않는 사진은 버려도 된다.`;
  const orderRule = options.keepOrder
    ? "imageOrder는 반드시 올린 순서(1,2,3...) 그대로여야 한다. 순서를 바꾸지 마라."
    : "imageOrder는 가장 재밌거나 자연스러운 이야기가 되도록 네가 순서를 정해도 된다.";

  return `너는 세로형(9:16) 숏폼 영상 연출가다. 사진 ${imageCount}장을 보고, 각 사진을 실제 동영상 클립(이미지→영상 AI)으로 만들기 위한 장면 계획을 짠다.

스타일: ${STYLE_LABEL[options.style]}

【사진 고르기·순서】
${countRule}
${orderRule}

【장면 설계 원칙】 이게 제일 중요하다.
- 한 장면에는 명확한 핵심 동작(keyAction) 하나만 둔다. 복잡한 연속 행동(예: "일어나서 걸어가 문을 열고 인사한다")은 하나로 몰아넣지 말고 여러 장면으로 나눠 생각해라.
- 사진에 실제로 보이는 인물·사물·배경에서 출발해라. 안 보이는 걸 지어내지 마라.
- preserveNotes에는 얼굴·체형·의상·소품·색상처럼 "이 장면에서 절대 바뀌면 안 되는 것"을 구체적으로 적어라. 영상 생성 모델이 엉뚱한 인물이나 색을 만들어내는 걸 막는 지시문이다.
- cameraMotion은 장면마다 무조건 과하게 움직이지 마라. 정적인 순간엔 static shot도 좋다.
- keyAction과 cameraMotion, preserveNotes는 모두 영어로 써라(영상 생성 모델에 그대로 들어간다).

【나레이션·자막】 (한국어)
${options.narrationEnabled ? "- narration: 각 장면 2~4초 분량(10~25자), 스타일 톤에 맞게 써라." : "- 나레이션은 안 쓴다. narration은 빈 문자열로 둬라."}
${options.subtitleEnabled ? "- subtitle: 화면에 보일 자막. 나레이션을 그대로 써도 되고, 더 짧게 다듬어도 된다." : "- 자막은 안 쓴다. subtitle은 빈 문자열로 둬라."}
- "아름다운", "환상적인", "신비로운" 같은 막연한 형용사를 쓰지 마라. 무슨 일이 벌어지는지를 말해라.

장면 수는 ${options.useAllImages ? imageCount : `${MIN_SCENE_COUNT}~${MAX_SCENE_COUNT}`}개, imageOrder 배열 길이와 scenes 배열 길이는 반드시 같아야 한다.`;
};

// 실제 Claude 비전 호출 — 비용이 든다. CLAUDE.md 규칙: 사용자의 명시적 승인 없이
// 호출부(API 라우트)가 이 클래스를 선택하지 않는다(getDefaultScenePlannerName 참고).
export class ClaudeScenePlanner implements ScenePlanner {
  readonly name = "claude-sonnet-5";

  async plan(imageUrls: string[], options: PlanOptions): Promise<PlanResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new MissingAnthropicKeyError();
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.parse({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [
            ...imageUrls.map((url) => ({
              type: "image" as const,
              source: { type: "url" as const, url },
            })),
            { type: "text" as const, text: buildInstruction(imageUrls.length, options) },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(PlanSchema), effort: "medium" },
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("장면 계획을 해석하지 못했습니다. 다시 시도해주세요.");
    }

    // 모델이 없는 번호를 부르거나 중복 사용할 수 있다 — 걸러내고, useAllImages인데
    // 빠진 사진이 있으면 실패로 처리한다(요청한 계약을 어겼으므로).
    const used = new Set<number>();
    const scenes: ScenePlan[] = [];
    for (let i = 0; i < parsed.imageOrder.length; i += 1) {
      const imageIndex = parsed.imageOrder[i];
      const scene = parsed.scenes[i];
      if (
        !scene ||
        !Number.isInteger(imageIndex) ||
        imageIndex < 1 ||
        imageIndex > imageUrls.length ||
        used.has(imageIndex)
      ) {
        continue;
      }
      used.add(imageIndex);
      scenes.push({ ...scene, imageIndex, prompt: composeVideoPrompt(scene) });
    }

    if (options.useAllImages && used.size !== imageUrls.length) {
      throw new Error(
        "모든 이미지를 사용하도록 요청했지만 일부 사진이 계획에서 빠졌습니다. 다시 시도해주세요.",
      );
    }
    if (scenes.length < MIN_SCENE_COUNT && !options.useAllImages) {
      throw new Error(`쓸 만한 장면이 ${scenes.length}개뿐이라 이야기가 안 됩니다. 다시 시도해주세요.`);
    }

    return { scenes };
  }
}

export const getScenePlanner = (name: string): ScenePlanner => {
  switch (name) {
    case "mock":
      return new MockScenePlanner();
    case "claude-sonnet-5":
      return new ClaudeScenePlanner();
    default:
      throw new Error(`알 수 없는 장면 계획 공급자입니다: ${name}`);
  }
};

// VIDEO_PROVIDER와 같은 이유로 기본은 항상 mock — 서버 환경변수를 직접 켜야만
// 실제 Claude 비전 호출(비용 발생)로 넘어간다.
export const getDefaultScenePlannerName = (): string =>
  process.env.VIDEO_SCENE_PLANNER?.trim() || "mock";

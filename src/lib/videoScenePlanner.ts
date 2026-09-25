import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { VideoStyle } from "@/lib/videoJobs";
import { AI_SFX_CUES, PREVIEW_SFX_CUES, aiSfxMenu, type SfxCue } from "@/lib/audioCatalog";

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
  sfx: SfxCue;
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

// 스타일마다 톤과 이야기 뼈대가 다르다. comic만 반전 구조를 강제하고, 나머지는
// 각자에 맞는 흐름을 따로 준다 — 여행/감성/광고에 억지로 "반전"을 요구하면
// 오히려 어색해진다(사용자 피드백: "대본이 이미지랑 안 어울리고 재미없다").
const STYLE_GUIDE: Record<VideoStyle, string> = {
  comic: `【이야기 뼈대】
- 첫 장면: 훅. 결과나 제일 웃긴 순간을 먼저 던져라. 배경 설명으로 시작하면 그 자리에서 넘긴다.
- 중간: 한 장면에 새 정보 하나씩. 장면이 끝날 때마다 "그래서 어떻게 됐는데?"가 남아야 한다.
- 뒤에서 두세 번째: 시청자가 속으로 품을 의심을 네가 먼저 말해라.
- 마지막 직전: 반전이나 웃긴 낙차. 여기가 제일 세야 한다.
- 마지막: 한 줄로 툭 끝낸다. 교훈이나 정리는 절대 쓰지 마라.
【톤】
- 위트·과장·자기 반응(당황·황당·억울함)으로 웃겨라. 다큐 내레이션이나 설명체("~했습니다", "~인데요", "~하는 방법")는 절대 쓰지 마라.
- 웃긴 포인트는 사진에 실제로 보이는 디테일(표정, 자세, 배경의 엉뚱한 요소)에서 뽑아라. 없는 사건을 지어내지 마라.
- "ㅋㅋ", "헐", "아니 진짜" 같은 구어체 반응을 아끼지 마라.`,
  jeju_travel: `【이야기 뼈대】
- 첫 장면: 훅. "이번 제주 여행에서 제일 좋았던 그 장면"을 먼저 보여준다는 느낌으로 시작해라. "제주도에 다녀왔습니다" 같은 밋밋한 도입은 쓰지 마라.
- 중간: 장소·순간을 하나씩 짚어가며 소개한다. 사진 순서를 그대로 나열하지 말고, 각 장면이 "그다음엔 뭘 했는지" 궁금하게 이어지게 해라.
- 마지막: 여운이나 한마디 추천으로 자연스럽게 닫는다.
【톤】
- 친구한테 여행 자랑하듯 구체적으로 말해라. 장소 이름, 시간대, 먹은 것, 느낀 감각처럼 사진에서 실제로 확인되는 디테일을 콕 집어 언급해라.
- 관광 안내 책자 문구("~로 유명한", "~을 즐길 수 있는", "꼭 가봐야 할")는 절대 쓰지 마라. 직접 겪은 사람의 말투로 써라.
- 과장된 감탄보다는 "왜 좋았는지" 이유가 드러나는 한마디가 낫다.`,
  emotional: `【이야기 뼈대】
- 첫 장면부터 담백하게 시작해라. 억지로 훅을 만들려 하지 말고, 가장 마음이 가는 순간부터 열어도 된다.
- 중간: 사진 속 구체적인 순간·행동을 시간 흐름이나 감정 흐름에 따라 하나씩 보여줘라.
- 마지막: 정리하거나 교훈을 말하지 말고, 여운이 남는 한 장면으로 조용히 닫아라.
【톤】
- "행복했다", "아름다웠다"처럼 감정을 직접 말하지 마라. 그 감정이 드러나는 행동이나 디테일을 보여줘라(예: "손을 꼭 잡았다", "말없이 한참 바라봤다").
- 과장된 수식어 없이 담백하게. 문장은 짧을수록 진솔하게 들린다.
- 사진에 실제로 보이는 표정·행동·소품에서 출발해라.`,
  product_ad: `【이야기 뼈대】
- 첫 장면: 이 제품/장면을 보자마자 눈길이 가는 이유를 훅으로 던져라.
- 중간: 제품의 실제 보이는 디테일(질감, 색, 형태, 쓰이는 방식)을 하나씩 근거로 대며 설득해라.
- 마지막: 과장된 구매 강요 대신, 자연스러운 한마디로 마무리해라("이 가격에 이 정도면", "하나쯤은 있어야지").
【톤】
- 막연한 칭찬("최고의 선택", "인생템")을 쓰지 말고, 사진에서 실제로 보이는 구체적 이유를 대라.
- 과장 광고 말투("지금 바로", "단 하나뿐인 기회")는 쓰지 마라. 담백하게 설득해라.`,
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
        // 실제 공급자처럼 장면마다 다른 sfx가 나오는 걸 미리보기에서도 보여주려고
        // 효과음을 순환시킨다(비용은 0원).
        sfx: PREVIEW_SFX_CUES[i % PREVIEW_SFX_CUES.length],
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
  sfx: z
    .enum(AI_SFX_CUES)
    .describe(
      "이 장면에 어울리는 효과음 큐. 반드시 주어진 목록 중 하나. 없는 게 나으면 'none'",
    ),
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

  const narrationRules = options.narrationEnabled
    ? `- 각 장면 narration은 소리 내어 읽었을 때 2~4초(공백 뺀 한글 8~25자).
- 【말이 이어지게】 전체 나레이션이 한 사람이 쉬지 않고 말하는 한 덩어리로 들려야 한다. 장면마다 뚝뚝 끊기는 독립된 설명문을 쓰지 마라. 이어붙이는 방법을 줄마다 바꿔가며 섞어 써라:
  · 연결어미로 넘기기 — "~했는데", "~더니", "~다가", "~길래"
  · 다음 줄이 접속사로 받기 — "근데", "그래서", "심지어", "결국"
  · 질문 던지고 다음 줄에서 답하기
  · 짧게 툭 끊고 다음 줄이 이어받기
  · 앞줄의 단어를 다음 줄 첫머리에서 다시 받기
  같은 연결 방법을 반복하면 억지로 갖다 붙인 티가 난다. 딱 끝맺는 건 마지막 장면 하나뿐이다.
- 【리듬】 모든 줄 길이가 비슷하면 기계가 읽는 것처럼 단조롭다. 공백 뺀 글자 수 기준으로 가장 짧은 줄은 8자 이하, 가장 긴 줄은 20~25자여야 한다(둘의 차이가 12자 이상). 한 장면에 문장 두 개를 넣지 마라.
- 【톤이 살아나게】 이 나레이션은 기계 음성이 읽는다. 문장부호·감탄사가 없으면 안내방송처럼 들린다: 전체 장면 중 물음표(?) 들어간 줄 최소 1개, 느낌표(!) 들어간 줄 최소 1개, 감탄사("헐", "아니", "와", "어?")로 시작하는 줄 최소 1개를 넣어라.
- 【자가검사】 다 쓰고 나서 줄 끝 두 글자만 세로로 읽어봐라. 같은 어미가 두 번 나오면 처음부터 다시 써라.`
    : "- 나레이션은 안 쓴다. narration은 빈 문자열로 둬라.";

  return `너는 10년차 숏폼 영상 연출가 겸 작가다. 사진 ${imageCount}장을 보고, (1) 각 사진을 실제 동영상 클립(이미지→영상 AI)으로 만들기 위한 장면 계획과 (2) 그 장면들을 하나로 잇는 한국어 나레이션을 함께 짠다.

스타일: ${STYLE_LABEL[options.style]}

【사진 고르기·순서】
${countRule}
${orderRule}

${STYLE_GUIDE[options.style]}

【장면 설계 원칙 — 영상 생성용(keyAction/cameraMotion/preserveNotes)】
- 한 장면에는 명확한 핵심 동작(keyAction) 하나만 둔다. 복잡한 연속 행동은 하나로 몰아넣지 말고 여러 장면으로 나눠 생각해라.
- 사진에 실제로 보이는 인물·사물·배경에서 출발해라. 안 보이는 걸 지어내지 마라.
- preserveNotes에는 얼굴·체형·의상·소품·색상처럼 "이 장면에서 절대 바뀌면 안 되는 것"을 구체적으로 적어라. 영상 생성 모델이 엉뚱한 인물이나 색을 만들어내는 걸 막는 지시문이다.
- cameraMotion은 장면마다 무조건 과하게 움직이지 마라. 정적인 순간엔 static shot도 좋다.
- keyAction과 cameraMotion, preserveNotes는 모두 영어로 써라(영상 생성 모델에 그대로 들어간다).

【나레이션·자막 — 한국어, 이게 시청자가 실제로 듣는 부분이다】
${narrationRules}
${options.subtitleEnabled ? "- subtitle: 화면에 보일 자막. 나레이션을 그대로 써도 되고, 더 짧게 다듬어도 된다." : "- 자막은 안 쓴다. subtitle은 빈 문자열로 둬라."}
- "아름다운", "환상적인", "신비로운", "따뜻한" 같은 막연한 형용사를 쓰지 마라. 무슨 일이 벌어지는지, 무엇이 보이는지를 말해라.
- 두루뭉술한 말 대신 사진에서 실제로 확인되는 구체적인 것을 넣어라("어떤 곳" 대신 실제 장소 특징, "많이" 대신 구체적 묘사).

【효과음(sfx)】 각 장면마다 다음 중 정확히 하나(괄호는 어떤 소리인지): ${aiSfxMenu()}. 장면 분위기 전환이나 강조가 필요 없으면 "none". 전부 "none"으로 채우지 말고, 톤이 바뀌거나 강조가 필요한 장면엔 실제로 어울리는 걸 골라라.

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

// "다른 대본" 버튼용 — 장면 하나만 다시 써준다. 전체 재계획(ClaudeScenePlanner.plan)은
// 이미지 전부를 다시 보내고 순서/선택까지 다시 정하는 무거운 호출이라, 나레이션 한 줄만
// 바꾸고 싶을 때 쓰기엔 비용·시간이 아깝다. 이건 이미지 한 장 + 이전 대본만 보낸다.
export type SceneRewriteResult = {
  narration: string;
  subtitle: string;
  sfx: SfxCue;
};

const SceneRewriteSchema = z.object({
  narration: z.string().describe("이 장면의 새로운 한국어 나레이션 한 줄"),
  subtitle: z.string().describe("화면에 표시할 한국어 자막"),
  sfx: z.enum(AI_SFX_CUES).describe("이 장면에 어울리는 효과음 큐"),
});

const buildRewriteInstruction = (
  style: VideoStyle,
  priorNarration: string,
  narrationEnabled: boolean,
  subtitleEnabled: boolean,
): string => `너는 숏폼 영상 작가다. 이 사진 한 장에 대한 나레이션을 새로 하나 더 써라. 사용자가 "다른 대본"을 눌러서 대안을 보고 싶어한다.

스타일: ${STYLE_LABEL[style]}

${STYLE_GUIDE[style]}

이전에 쓴 나레이션: "${priorNarration || "(없음)"}"
- 이전 것과 표현이나 접근을 확실히 다르게 써라. 단어만 살짝 바꾼 재탕은 실패다.
- 사진에 실제로 보이는 것에서 출발해라. 안 보이는 걸 지어내지 마라.
- "아름다운", "환상적인", "신비로운", "따뜻한" 같은 막연한 형용사를 쓰지 마라.

${
  narrationEnabled
    ? `narration: 소리 내어 읽었을 때 2~4초(공백 뺀 한글 8~25자), 문장 하나만. 스타일 톤에 맞는 구어체로 쓰고, 물음표·느낌표·감탄사 중 최소 하나로 톤을 살려라.`
    : `narration은 빈 문자열로 둬라 (이 작업은 내레이션을 쓰지 않는다).`
}
${subtitleEnabled ? "subtitle: 화면 자막. 나레이션을 그대로 써도 되고 더 짧게 다듬어도 된다." : "subtitle은 빈 문자열로 둬라."}
sfx: 다음 중 정확히 하나(괄호는 어떤 소리인지): ${aiSfxMenu()}. 없는 게 나으면 none.`;

export const rewriteSceneNarration = async (
  imageUrl: string,
  style: VideoStyle,
  priorNarration: string,
  narrationEnabled: boolean,
  subtitleEnabled: boolean,
): Promise<SceneRewriteResult> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new MissingAnthropicKeyError();
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image" as const, source: { type: "url" as const, url: imageUrl } },
          {
            type: "text" as const,
            text: buildRewriteInstruction(style, priorNarration, narrationEnabled, subtitleEnabled),
          },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(SceneRewriteSchema), effort: "low" },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("새 대본을 해석하지 못했습니다. 다시 시도해주세요.");
  }
  return parsed;
};

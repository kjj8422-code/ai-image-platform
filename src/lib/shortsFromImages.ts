import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BGM_MOODS, SFX_LIBRARY } from "@/lib/shortsStoryboard";

// 사용자가 올린 이미지 5~10장을 Claude가 직접 "보고" B급 썰체 시나리오를 쓴다.
//
// Replicate 경유 Claude는 텍스트 입력만 받기 때문에(입력 필드가 prompt/max_tokens/
// system_prompt뿐) 이미지 분석이 불가능하다. 그래서 이 파일만 Anthropic 공식 SDK를
// 직접 호출한다. 다른 기능(썸네일 문구·프롬프트 보강)은 기존대로 Replicate를 쓴다.

const MODEL = "claude-sonnet-5";

export const MIN_IMAGES = 5;
export const MAX_IMAGES = 10;

// 응답 형식을 정규식으로 긁어 파싱하면 모델이 형식을 어겼을 때 조용히 깨진다.
// 구조화 출력(Zod)으로 스키마를 강제해 그 실패 경로 자체를 없앤다.
const SceneSchema = z.object({
  narration: z
    .string()
    .describe("이 장면에서 읽을 한국어 나레이션 한 줄 (썰체, 2~4초 분량)"),
  sfx: z.enum(SFX_LIBRARY).describe("이 장면 시작에 깔 효과음 큐"),
  kenBurns: z.enum(["in", "out"]).describe("느린 줌 방향"),
});

const StoryboardSchema = z.object({
  thumbnailCopy: z
    .string()
    .describe("3~4단어 한국어 썸네일 문구. 요약이 아니라 반응/훅이어야 한다"),
  bgmMood: z.enum(BGM_MOODS),
  scenes: z.array(SceneSchema).describe("업로드된 이미지와 같은 순서, 같은 개수"),
});

export type ImageStoryboardScene = z.infer<typeof SceneSchema> & {
  index: number;
  imageUrl: string;
};

export type ImageStoryboard = {
  thumbnailCopy: string;
  bgmMood: z.infer<typeof StoryboardSchema>["bgmMood"];
  scenes: ImageStoryboardScene[];
};

const buildInstruction = (imageCount: number): string => `너는 10년차 B급/C급 바이럴 숏폼 작가야. 한국 유튜브 쇼츠·인스타 릴스에서 스크롤을 멈추게 만드는 썰을 쓴다.

지금 이미지 ${imageCount}장을 순서대로 받았어. 이 이미지들을 실제로 보고, 그 흐름에 맞는 15~30초짜리 숏폼 시나리오를 써줘.

나레이션 규칙:
- 이미지에 실제로 보이는 것을 근거로 써. 없는 걸 지어내지 마.
- 썰체/구어체만 쓴다. 친구한테 방금 겪은 황당한 일을 말하듯이.
- 다큐 내레이션이나 딱딱한 설명체 절대 금지. "~하는 방법", "~의 모든 것", "오늘은 ~에 대해 알아보겠습니다" 같은 표현이 나오면 실패한 거야.
- 위트, 도발, 억울함, 반전을 적극 써라. 보는 사람이 "어? 이거 진짜임?", "말도 안 돼 ㅋㅋㅋ" 하게 만들어야 한다.
- 어미에 "ㅋㅋㅋ", "ㄷㄷ", "??" 같은 모바일 말투를 자연스럽게 섞어. 억지로 매 줄에 넣지는 말고.
- 첫 장면은 무조건 스크롤을 멈추게 하는 훅. 마지막 장면은 반전이나 빵 터지는 마무리.
- 각 장면 나레이션은 소리 내어 읽었을 때 2~4초(한글 10~25자 정도).

효과음(sfx)은 장면마다 하나씩 고른다. 1번 장면은 보통 boom이나 suspense, 반전 장면은 reveal이나 laugh가 어울린다. 효과음이 없는 게 나으면 none.

kenBurns는 in(긴장·집중) 또는 out(공개·스케일)을 장면 성격에 맞게 번갈아 쓴다.

thumbnailCopy는 3~4어절 한국어 훅이다. 이미지 내용을 요약하지 말고, 보자마자 누르고 싶게 만드는 반응형 문구로 써라.

장면은 정확히 ${imageCount}개, 받은 이미지와 같은 순서로 만들어야 한다.`;

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      "서버 설정 오류: ANTHROPIC_API_KEY가 없습니다. 이미지 분석 기능을 쓰려면 " +
        "console.anthropic.com에서 키를 발급받아 환경변수로 등록해주세요.",
    );
  }
}

export const generateStoryboardFromImages = async (
  imageUrls: string[],
): Promise<ImageStoryboard> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new MissingAnthropicKeyError();
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // 이미지 여러 장을 보고 흐름을 짜는 작업이라 적응형 사고를 켠다.
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: [
          ...imageUrls.map((url) => ({
            type: "image" as const,
            source: { type: "url" as const, url },
          })),
          { type: "text" as const, text: buildInstruction(imageUrls.length) },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(StoryboardSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("시나리오를 해석하지 못했습니다. 다시 시도해주세요.");
  }

  // 장면 수가 이미지 수와 어긋나면 뒤쪽 합성이 전부 틀어지므로 여기서 맞춘다.
  const scenes = parsed.scenes.slice(0, imageUrls.length).map((scene, i) => ({
    ...scene,
    index: i + 1,
    imageUrl: imageUrls[i],
  }));

  if (scenes.length !== imageUrls.length) {
    throw new Error(
      `장면 수(${scenes.length})가 이미지 수(${imageUrls.length})와 맞지 않습니다. 다시 시도해주세요.`,
    );
  }

  return {
    thumbnailCopy: parsed.thumbnailCopy.trim(),
    bgmMood: parsed.bgmMood,
    scenes,
  };
};

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
- 【말이 이어지게】 6줄 전체가 한 사람이 쉬지 않고 말하는 한 덩어리로 들려야 한다.
  단 이어붙이는 방법을 줄마다 바꿔라. 같은 방법을 반복하면 억지로 갖다 붙인 티가
  나고 오히려 더 어색하게 들린다. 아래를 섞어 써라:
  · 연결어미로 넘기기 — "~했는데", "~더니", "~다가", "~길래"
  · 다음 줄이 접속사로 받기 — "근데", "그래서", "아니 근데", "심지어", "결국"
  · 질문 던지고 다음 줄에서 답하기 — "이게 말이 되냐?" 다음 줄 "되더라고"
  · 짧게 툭 끊고 다음 줄이 이어받기 — "근데 안 꺼짐." 다음 줄 "세 시간째."
  · 앞줄의 단어를 다음 줄 첫머리에서 다시 받기
- 【리듬】 줄 길이를 들쭉날쭉하게 섞어라. 6줄이 전부 비슷한 길이면 읽을 때 리듬이
  죽어서 기계가 읽는 것처럼 들린다. 짧은 줄(5~10자)과 긴 줄(20자 안팎)을 섞어라.
- 위 두 규칙의 자가검사: 같은 어미로 끝나는 줄이 두 개 이상이면 실패다. 다시 써라.
  ("~는데"가 두 번 나오거나 "~길래"가 두 번 나오면 그 대본은 버리고 새로 쓴다.)
- 딱 끝맺는 건 마지막 장면 하나뿐이다.

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

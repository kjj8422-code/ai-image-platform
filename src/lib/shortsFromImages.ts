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
export const MAX_IMAGES = 15;

// 올린 사진을 전부 쓰지 않는다. 한 이야기로 안 묶이는 사진까지 억지로 끼워 넣으면
// 그 사진을 설명하려고 군더더기 장면이 생기고, 반전까지 거기에 맞춰 비틀려서
// 이야기 전체가 무너진다. 어울리는 것만 고르고 나머지는 버린다.
export const MIN_SCENES = 4;
export const MAX_SCENES = 8;

// 응답 형식을 정규식으로 긁어 파싱하면 모델이 형식을 어겼을 때 조용히 깨진다.
// 구조화 출력(Zod)으로 스키마를 강제해 그 실패 경로 자체를 없앤다.
const SceneSchema = z.object({
  imageIndex: z
    .number()
    .int()
    .describe(
      "이 장면에 쓸 사진 번호. 올린 순서대로 1부터 센다. 사진마다 정확히 한 번씩 쓴다",
    ),
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
  scenes: z
    .array(SceneSchema)
    .describe("이야기 순서대로. 사진 수와 같은 개수여야 한다"),
});

export type ImageStoryboardScene = z.infer<typeof SceneSchema> & {
  index: number;
  imageUrl: string;
};

// 모델이 없는 사진 번호를 부르거나 같은 사진을 두 번 쓸 수 있다. 그런 장면만
// 걷어내고 나머지로 영상을 만든다. 통째로 실패시키면 사용자는 API 비용만 치르고
// 아무것도 못 받는다.
const takeUsableScenes = <T extends { imageIndex: number }>(
  scenes: T[],
  imageCount: number,
): T[] => {
  const used = new Set<number>();
  const kept: T[] = [];
  for (const scene of scenes) {
    const n = scene.imageIndex;
    if (!Number.isInteger(n) || n < 1 || n > imageCount || used.has(n)) continue;
    used.add(n);
    kept.push(scene);
    if (kept.length >= MAX_SCENES) break;
  }
  return kept;
};

export type ImageStoryboard = {
  thumbnailCopy: string;
  bgmMood: z.infer<typeof StoryboardSchema>["bgmMood"];
  scenes: ImageStoryboardScene[];
};

const buildInstruction = (imageCount: number): string => `너는 10년차 B급/C급 바이럴 숏폼 작가야. 한국 유튜브 쇼츠·인스타 릴스에서 스크롤을 멈추게 만드는 썰을 쓴다.

지금 사진 ${imageCount}장을 받았어. 올린 순서는 아무 의미 없다.

【사진 고르기】 이게 제일 중요하다. 받은 사진을 다 쓰지 마라.
- 올라온 사진에는 한 이야기로 묶이는 것들과, 그냥 같은 날 찍혔을 뿐인 것들이 섞여 있다. 하나의 이야기가 되는 사진만 고르고 나머지는 과감히 버려라.
- 안 어울리는 사진을 끼워 넣으면, 그 사진을 설명하려고 군더더기 장면이 생기고 반전까지 거기 맞춰 비틀려서 이야기 전체가 무너진다. 사진 한 장 살리려다 영상을 버리는 짓이다. 버린 사진은 다음 영상에 쓰면 된다.
- 장면은 ${MIN_SCENES}~${MAX_SCENES}개로 만든다. 사진이 ${imageCount}장이어도 ${MAX_SCENES}개를 넘기지 마라. 쇼츠는 짧을수록 끝까지 본다. 5~6개가 가장 좋고, 이야기가 확실할 때만 7~8개로 늘려라.
- 각 장면의 imageIndex에 그 장면에서 쓸 사진 번호(1~${imageCount}, 올린 순서 기준)를 적는다. 같은 사진을 두 번 쓰지 마라.
- 고른 사진들은 가장 재밌는 이야기가 되도록 네가 순서를 정해라. 올린 순서를 따를 필요 없다.

【이야기 뼈대】 고른 장면들을 이 흐름으로 짜라.
- 첫 장면: 훅. 결과나 제일 이상한 장면을 먼저 던져라. 배경 설명으로 시작하면 그 자리에서 넘긴다.
- 중간: 한 장면에 새 정보 하나씩만. 장면이 끝날 때마다 "그래서 어떻게 됐는데?" 가 남아야 한다.
- 뒤에서 두세 번째: 시청자가 속으로 품을 의심을 네가 먼저 말해라. ("이거 편집 아니냐고?")
- 마지막 직전: 반전. 앞에서 깔아둔 게 뒤집힌다. 여기가 제일 세야 한다.
- 마지막: 한 줄로 툭 끝낸다. 교훈이나 정리는 절대 쓰지 마라.

【허접해 보이지 않으려면】 이게 제일 중요하다.
- 사진에 실제로 보이는 것에서 출발해라. 안 보이는 걸 지어내는 순간 유치해진다.
- "아름다운", "환상적인", "신비로운", "따뜻한" 같은 형용사를 쓰지 마라. 무슨 일이 벌어졌는지만 말해라. 감상은 보는 사람이 한다.
- 두루뭉술한 말 대신 숫자와 구체적인 것을 넣어라. "한참" 대신 "세 시간째", "많이" 대신 "네 번", "어떤 사람" 대신 "옆에 있던 아저씨".
- 자랑하지 마라. 당황하고, 억울해하고, 실패해라. 일이 잘 풀리는 얘기는 아무도 안 본다.
- 이미 아는 사실을 설명하지 마라. 아무도 모르던 것, 혹은 알지만 말 안 하던 것을 말해라.

나레이션 규칙:
- 썰체/구어체만 쓴다. 친구한테 방금 겪은 황당한 일을 말하듯이.
- 다큐 내레이션이나 딱딱한 설명체 절대 금지. "~하는 방법", "~의 모든 것", "오늘은 ~에 대해 알아보겠습니다" 같은 표현이 나오면 실패한 거야.
- 어미에 "ㅋㅋㅋ", "ㄷㄷ", "??" 같은 모바일 말투를 자연스럽게 섞어. 억지로 매 줄에 넣지는 말고.
- 각 장면 나레이션은 소리 내어 읽었을 때 2~4초(한글 10~25자 정도).
- 【말이 이어지게】 나레이션 전체가 한 사람이 쉬지 않고 말하는 한 덩어리로 들려야 한다. 단 이어붙이는 방법을 줄마다 바꿔라. 같은 방법을 반복하면 억지로 갖다 붙인 티가 나고 오히려 더 어색하게 들린다. 아래를 섞어 써라:
  · 연결어미로 넘기기 — "~했는데", "~더니", "~다가", "~길래"
  · 다음 줄이 접속사로 받기 — "근데", "그래서", "아니 근데", "심지어", "결국"
  · 질문 던지고 다음 줄에서 답하기 — "이게 말이 되냐?" 다음 줄 "되더라고"
  · 짧게 툭 끊고 다음 줄이 이어받기 — "근데 안 꺼짐." 다음 줄 "세 시간째."
  · 앞줄의 단어를 다음 줄 첫머리에서 다시 받기
- 【리듬】 전부 비슷한 길이면 읽을 때 리듬이 죽어서 기계가 읽는 것처럼 들린다. 숫자로 지킬 것:
  · 공백을 뺀 글자 수로 셌을 때, 가장 짧은 줄은 8자 이하여야 한다.
  · 가장 긴 줄은 20자 이상이어야 한다.
  · 즉 가장 긴 줄과 가장 짧은 줄의 차이가 12자 이상이어야 한다. 모든 줄이 10~15자 언저리로 고르게 나오면 그건 실패다.
  · 8자 이하인 짧은 줄은 반전 직전이나 직후에 놓으면 제일 세게 꽂힌다. ("근데 안 꺼짐.", "세 시간째.")
- 【자가검사】 다 쓰고 나서 줄 끝 두 글자만 세로로 읽어봐라. 같은 게 두 번 나오면
  ("~는데"가 2번, "~더라"가 2번 같은 경우) 그 대본은 버리고 처음부터 다시 써라.
  하나도 겹치지 않아야 통과다.
- 딱 끝맺는 건 마지막 장면 하나뿐이다.
- 【톤이 살아나게】 이 대본은 기계 음성이 소리 내어 읽는다. 문장부호와 감탄사가 없으면 전부 같은 높이, 같은 크기로 읽어서 감정 없는 안내방송처럼 들린다. 아래를 반드시 지켜라:
  · 물음표(?)가 들어간 줄이 최소 하나 — 의심하거나 되묻는 장면
  · 느낌표(!)가 들어간 줄이 최소 하나 — 반전이나 놀라는 장면
  · 말줄임표(...)로 뜸 들이는 줄이 하나 — 긴장을 끄는 장면
  · 감탄사로 시작하는 줄이 최소 둘 — "헐", "아니", "와", "야", "잠깐", "어?"
    감탄사는 읽는 억양을 가장 확실하게 바꾸는 장치다. 아끼지 마라.
  · 모든 줄이 부호 없이 끝나면 실패다. 다시 써라.

효과음(sfx)은 장면마다 하나씩 고른다. 첫 장면은 보통 boom이나 suspense, 반전 장면은 reveal이나 laugh가 어울린다. 효과음이 없는 게 나으면 none.

kenBurns는 in(긴장·집중) 또는 out(공개·스케일)을 장면 성격에 맞게 번갈아 쓴다.

thumbnailCopy는 3~4어절 한국어 훅이다. 이미지 내용을 요약하지 말고, 보자마자 누르고 싶게 만드는 반응형 문구로 써라.`;

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
    output_config: {
      format: zodOutputFormat(StoryboardSchema),
      // 이 라우트는 Vercel에서 60초 안에 끝나야 한다(maxDuration). 사진이 10장까지
      // 늘면 기본값으로는 그 안에 못 끝낼 수 있는데, 6~10장면짜리 대본은 medium으로도
      // 품질이 떨어지지 않는다. 시간 초과로 아무것도 못 받는 쪽이 훨씬 나쁘다.
      effort: "medium",
    },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("시나리오를 해석하지 못했습니다. 다시 시도해주세요.");
  }

  // 장면 수가 이미지 수와 어긋나면 뒤쪽 합성이 전부 틀어지므로 여기서 맞춘다.
  const usable = takeUsableScenes(parsed.scenes, imageUrls.length);
  if (usable.length < MIN_SCENES) {
    throw new Error(
      `쓸 만한 장면이 ${usable.length}개뿐이라 이야기가 안 됩니다. 다시 시도해주세요.`,
    );
  }
  const scenes = usable.map((scene, i) => ({
    ...scene,
    index: i + 1,
    imageUrl: imageUrls[scene.imageIndex - 1],
  }));

  return {
    thumbnailCopy: parsed.thumbnailCopy.trim(),
    bgmMood: parsed.bgmMood,
    scenes,
  };
};

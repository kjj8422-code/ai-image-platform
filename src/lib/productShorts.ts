import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AI_BGM_MOODS, AI_SFX_CUES, aiBgmMenu, aiSfxMenu } from "./audioCatalog.ts";
import { MissingAnthropicKeyError } from "./shortsFromImages.ts";
import {
  MIN_PRODUCT_SCENES,
  buildDescription,
  buildPinnedComment,
  clampRating,
  findFakeExperienceClaims,
  isQuoteFromReviews,
  takeProductScenes,
} from "./productShortsRules.ts";

export * from "./productShortsRules.ts";

// 쿠팡 꿀템 쇼츠: 상품 사진 + 상품 설명 + 실제 구매 후기로 쇼핑 쇼츠 대본을 만든다.
//
// 핵심 원칙 — 진행자(AI)는 상품을 써 본 사람이 아니다. 사용 경험은 전부 실제 구매
// 후기에서 가져와 "구매자들이 이렇게 말한다"로 전한다. AI 인물이 "제가 써 봤는데"라고
// 말하면 없는 경험을 지어낸 광고(기만 광고)가 되고, 쿠팡 파트너스 약관 위반으로 계정이
// 막힐 수 있다. 반대로 진짜 후기를 그대로 보여주는 게 쇼핑 쇼츠에서 가장 현실적이고
// 가장 잘 팔린다 — 그래서 후기 인용은 모델이 지어내지 못하게 서버에서 원문과 대조한다.

const MODEL = "claude-sonnet-5";

export const HOOK_TYPES = ["문제제시", "가격충격", "비교", "후기인용", "반전"] as const;

const SceneSchema = z.object({
  imageIndex: z
    .number()
    .int()
    .describe("이 장면에 쓸 상품 사진 번호(올린 순서, 1부터). 같은 사진을 여러 장면에 써도 된다"),
  narration: z.string().describe("이 장면 나레이션 한 줄 (한국어, 소리 내어 2~4초)"),
  reviewQuote: z
    .string()
    .describe(
      "이 장면 화면에 띄울 구매 후기 한 구절. 받은 후기 원문에서 글자 그대로 복사한 15~60자. 후기 장면이 아니면 빈 문자열",
    ),
  reviewRating: z.number().int().describe("reviewQuote를 쓴 후기의 별점(1~5). 모르면 5"),
  sfx: z.enum(AI_SFX_CUES).describe("이 장면 시작 효과음"),
  kenBurns: z.enum(["in", "out"]).describe("느린 줌 방향"),
});

const ProductScriptSchema = z.object({
  hooks: z
    .array(
      z.object({
        type: z.enum(HOOK_TYPES),
        text: z.string().describe("영상 첫 1초 화면에 크게 띄울 문장 (한국어 6~16자)"),
      }),
    )
    .describe("첫 문장 후보 5개. 유형을 골고루"),
  thumbnailCopy: z.string().describe("hooks 중 가장 센 것 하나를 그대로"),
  bgmMood: z.enum(AI_BGM_MOODS),
  scenes: z.array(SceneSchema).describe("영상 순서대로 5~7장면"),
  reviewInsights: z.object({
    pros: z.array(z.string()).describe("후기에서 반복되는 장점 3개 (짧게)"),
    cons: z.array(z.string()).describe("후기에 나온 단점 1~2개 (없으면 빈 배열)"),
  }),
  youtubeTitle: z.string().describe("유튜브 제목 (40자 이내, 검색될 상품 키워드 포함)"),
  hashtags: z.array(z.string()).describe("해시태그 5개, # 포함"),
  description: z.string().describe("설명란 본문 2~3줄 (링크·광고 문구는 쓰지 마라, 서버가 붙인다)"),
  pinnedComment: z.string().describe("고정 댓글 첫 줄. 링크를 누르고 싶게 만드는 한 줄"),
});

export type ProductScene = z.infer<typeof SceneSchema> & { index: number; imageUrl: string };

export type ProductScript = Omit<z.infer<typeof ProductScriptSchema>, "scenes"> & {
  scenes: ProductScene[];
  warnings: string[];
};

export type ProductInput = {
  imageUrls: string[];
  productName: string;
  price: string;
  description: string;
  reviews: string;
  link: string;
};

// ---------------------------------------------------------------------------
// 프롬프트
// ---------------------------------------------------------------------------

const buildInstruction = (input: ProductInput): string => `너는 한국 유튜브 쇼핑 쇼츠 전문 작가야. 목표는 딱 하나 — 끝까지 보게 하고, 고정 댓글의 링크를 누르게 만드는 것.

지금 상품 사진 ${input.imageUrls.length}장(올린 순서대로 1번부터), 상품 정보, 실제 구매자 후기를 받았다.

【상품 정보】
- 상품명: ${input.productName || "(사진과 설명을 보고 판단)"}
- 가격: ${input.price || "(가격 언급 금지)"}
- 설명:
${input.description || "(없음)"}

【실제 구매 후기 원문】
${input.reviews}

━━━━━━━━━━━━━━━━━━━━
【절대 규칙 — 어기면 광고법 위반이다】
1. 진행자는 이 상품을 써 본 적이 없다. "제가 써 봤는데", "저도 샀어요", "한 달째 쓰는 중", "반품했어요" 같은 1인칭 경험을 절대 쓰지 마라.
   사용 경험은 전부 후기에서 가져와서 "구매자들이", "후기 보면", "리뷰에 제일 많은 말이" 처럼 전달한다.
2. 위 설명과 후기에 없는 사실(효능, 수치, 성분, 인증, 할인, 판매량)을 지어내지 마라. 가격은 위에 적힌 가격만 쓴다.
3. reviewQuote는 위 후기 원문에서 글자 그대로 복사한다. 한 글자도 고치거나 요약하지 마라. 이름, 아이디, 주문번호, 옵션 정보는 빼고 문장만 가져온다. 서버가 원문과 대조해서 다르면 버린다.
4. 병을 고친다, 살이 빠진다 같은 의학적·효과 보장 표현 금지.

【영상 구조】 5~7장면, 합쳐서 20~30초.
- 1장면(훅): hooks 중 가장 센 문장을 말로 연다. 설명으로 시작하면 넘긴다.
- 2장면(공감): 이 상품이 해결하는 불편을 시청자 입장에서 한 줄로.
- 3장면(해결): 상품을 보여주며 핵심 장점 하나.
- 4~5장면(증거): 후기 장면. reviewQuote를 채우고, 나레이션은 그 후기를 전하는 말("구매자분이 이랬어요", "이런 후기가 제일 많아요").
- 후기에 단점이 있으면 한 장면에서 솔직하게 짧게 말한다. 단점을 숨기지 않는 게 신뢰를 만든다.
- 마지막: 가격(있으면)과 "링크는 고정 댓글에" 로 짧게 끝낸다.
- 후기 장면(reviewQuote가 있는 장면)은 2~3개. 나머지 장면의 reviewQuote는 빈 문자열.

【첫 문장 후보 hooks】 5개, 유형을 섞어라:
- 문제제시: "○○ 때문에 짜증 난 사람?"
- 가격충격: 입력된 가격이 있을 때만
- 비교: "비싼 거 사기 전에 이거"
- 후기인용: 후기의 가장 센 한마디를 그대로
- 반전: 예상과 다른 한 줄
각 6~16자. "꿀템 소개", "추천합니다" 같은 밋밋한 말은 실패다.

【나레이션 말투】
- 친한 언니·오빠가 톡 보내듯 구어체. 다큐·광고 성우 말투 금지.
- 한 장면 한 문장, 10~25자. 가장 짧은 줄은 8자 이하가 하나 있어야 리듬이 산다.
- 물음표 한 번, 느낌표 한 번 이상. 기계 음성이 읽으므로 부호가 억양을 만든다.

【사진】 imageIndex는 1~${input.imageUrls.length}. 같은 사진을 다른 장면에 다시 써도 된다. 장면 내용에 가장 맞는 사진을 골라라.

효과음(sfx) 목록: ${aiSfxMenu()}. 훅은 boom·impact·ding, 후기 장면은 ding·chime·message, 가격 장면은 coin이 잘 맞는다. 같은 소리를 연달아 쓰지 마라.
배경음악(bgmMood): ${aiBgmMenu()} 중 상품 분위기에 맞는 것.
kenBurns는 in/out을 번갈아.

【업로드용】
- youtubeTitle: 40자 이내. 사람들이 검색할 상품 키워드를 앞쪽에.
- hashtags: 5개. 상품 종류 키워드 + #쿠팡추천 같은 쇼핑 키워드.
- description: 2~3줄. 링크와 광고 문구는 쓰지 마라(서버가 붙인다).
- pinnedComment: 링크 누르고 싶게 만드는 한 줄.`;

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

export const generateProductScript = async (input: ProductInput): Promise<ProductScript> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new MissingAnthropicKeyError();
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: [
          ...input.imageUrls.map((url) => ({
            type: "image" as const,
            source: { type: "url" as const, url },
          })),
          { type: "text" as const, text: buildInstruction(input) },
        ],
      },
    ],
    output_config: {
      format: zodOutputFormat(ProductScriptSchema),
      // Vercel 60초 안에 끝나야 한다(shortsFromImages와 같은 이유).
      effort: "medium",
    },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("대본을 해석하지 못했습니다. 다시 시도해주세요.");
  }

  const warnings: string[] = [];
  const usable = takeProductScenes(parsed.scenes, input.imageUrls.length);
  if (usable.length < MIN_PRODUCT_SCENES) {
    throw new Error(`쓸 만한 장면이 ${usable.length}개뿐입니다. 다시 시도해주세요.`);
  }

  let droppedQuotes = 0;
  const scenes: ProductScene[] = usable.map((scene, i) => {
    const quoteOk = !scene.reviewQuote || isQuoteFromReviews(scene.reviewQuote, input.reviews);
    if (!quoteOk) droppedQuotes += 1;
    return {
      ...scene,
      reviewQuote: quoteOk ? scene.reviewQuote.trim() : "",
      reviewRating: clampRating(scene.reviewRating),
      index: i + 1,
      imageUrl: input.imageUrls[scene.imageIndex - 1],
    };
  });

  if (droppedQuotes > 0) {
    warnings.push(
      `AI가 후기 원문과 다르게 옮긴 인용 ${droppedQuotes}개를 뺐어요. 필요하면 후기 칸에 원문 문장을 직접 붙여 넣으세요.`,
    );
  }
  const claims = findFakeExperienceClaims(scenes.map((s) => s.narration));
  if (claims.length > 0) {
    warnings.push(
      `진행자가 직접 써 본 것처럼 들리는 줄이 있어요. "구매자들이 ~래요"처럼 바꿔 주세요: ${claims.map((c) => `"${c}"`).join(", ")}`,
    );
  }

  return {
    ...parsed,
    scenes,
    description: buildDescription(parsed.description, parsed.hashtags, input.link),
    pinnedComment: buildPinnedComment(parsed.pinnedComment, input.link),
    warnings,
  };
};

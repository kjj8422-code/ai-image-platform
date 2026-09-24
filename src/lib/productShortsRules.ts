// 쿠팡 꿀템 쇼츠의 규칙들. AI SDK를 import하지 않아서 화면(브라우저)에서도 쓸 수 있다
// — 사용자가 후기 인용을 직접 고칠 때도 원문과 같은지 바로 확인하려고 따로 뺐다.

export const MIN_PRODUCT_IMAGES = 1;
export const MAX_PRODUCT_IMAGES = 10;
export const MIN_PRODUCT_SCENES = 4;
export const MAX_PRODUCT_SCENES = 8;
// 입력이 길수록 비용과 시간이 는다. 쿠팡 후기 수십 개를 붙여 넣어도 들어가는 정도.
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_REVIEWS_CHARS = 8000;
export const MIN_REVIEWS_CHARS = 20;

// 쿠팡 파트너스가 요구하는 대가성 문구. 설명란과 고정 댓글에 항상 붙인다.
export const COUPANG_DISCLOSURE =
  "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";

// 따옴표·공백 차이는 무시하고 비교한다. 모델은 후기를 옮기며 줄바꿈이나 따옴표를
// 바꾸곤 하는데, 그건 "지어낸 것"이 아니다.
const normalize = (text: string): string =>
  text
    .replace(/[“”"‘’'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const isQuoteFromReviews = (quote: string, reviews: string): boolean => {
  const q = normalize(quote);
  return q.length > 0 && normalize(reviews).includes(q);
};

// 진행자가 직접 써 본 것처럼 말하는 표현. 발견되면 경고로 알려 준다(자동으로 고치면
// 문장이 어색해지므로 사람이 한 번 보게 한다).
const FAKE_EXPERIENCE_PATTERNS: RegExp[] = [
  /제가\s*(직접\s*)?(써|사용|먹|입|발라|신어|해\s*봤)/,
  /(써|사용해|먹어|입어|발라|신어)\s*보니/,
  /(써|사용해|먹어|입어|발라|신어)\s*봤/,
  /(저도|나도|제가)\s*(샀|구매|주문)/,
  /반품했/,
  /(\d+|한|두|세|네|몇)\s*(일|주|달|개월|년)\s*(째|동안)\s*(쓰|사용|먹|입)/,
];

export const findFakeExperienceClaims = (narrations: string[]): string[] =>
  narrations.filter((line) => FAKE_EXPERIENCE_PATTERNS.some((re) => re.test(line)));

// 사진 번호가 범위 밖인 장면은 버린다. 상품 사진은 몇 장뿐이라 재사용은 허용한다.
export const takeProductScenes = <T extends { imageIndex: number }>(
  scenes: T[],
  imageCount: number,
): T[] =>
  scenes
    .filter((s) => Number.isInteger(s.imageIndex) && s.imageIndex >= 1 && s.imageIndex <= imageCount)
    .slice(0, MAX_PRODUCT_SCENES);

export const clampRating = (value: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 1), 5) : 5;

export const LINK_PLACEHOLDER = "[여기에 쿠팡 파트너스 링크]";

export const buildDescription = (body: string, hashtags: string[], link: string): string =>
  [
    body.trim(),
    "",
    `👉 상품 보러 가기: ${link.trim() || LINK_PLACEHOLDER}`,
    "",
    hashtags.join(" "),
    "",
    COUPANG_DISCLOSURE,
  ].join("\n");

// 쇼츠 댓글 링크는 눌리지 않고(2023년 8월부터), 링크는 나중에 유튜브 쇼핑 태그로
// 붙인다. 그래서 고정 댓글에는 링크를 넣지 않고 한마디와 광고 표시만 둔다.
export const buildPinnedComment = (line: string): string =>
  [line.trim(), "", COUPANG_DISCLOSURE].join("\n");


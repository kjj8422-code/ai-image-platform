import path from "node:path";
import {
  createCanvas,
  GlobalFonts,
  loadImage,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";

// 서버(API Route)에서 @napi-rs/canvas로 9:16 쇼츠/릴스 썸네일을 합성한다.
// 클라이언트 브라우저마다 폰트/렌더링이 달라지는 문제 없이, 항상 같은 결과가
// 나오도록 배경 자르기 + 그라데이션 + 문구 합성을 전부 서버에서 처리한다.

export const THUMBNAIL_WIDTH = 1080;
export const THUMBNAIL_HEIGHT = 1920;

// 쇼츠/릴스 플랫폼 UI가 실제로 가리는 영역 비율.
export const SAFE_ZONE = {
  bottomRatio: 0.25, // 하단 25%: 제목/채널정보/설명
  rightRatio: 0.15, // 우측 15%: 좋아요/댓글/공유 버튼
};

const SIDE_MARGIN = Math.round(THUMBNAIL_WIDTH * SAFE_ZONE.rightRatio);
// 처음엔 y=450(상단~중앙)에 두었는데, 실제 생성된 사진들을 보니 그 위치가
// 인물의 팔/소품과 자주 겹쳐 어색했다(사용자가 실제 결과로 지적). 제목을 화면
// 맨 위쪽으로 올리고, 배경 생성 프롬프트 쪽에서 이 영역을 비워두도록 지시하는
// 방식으로 바꿨다 — 실제 유튜브 쇼츠 썸네일들도 문구는 상단, 인물/소품은
// 중앙~하단에 두는 구도가 많다.
const TITLE_TOP_Y = 170;
const SAFE_BOTTOM_Y = Math.round(
  THUMBNAIL_HEIGHT * (1 - SAFE_ZONE.bottomRatio),
);

const MAX_TEXT_LINES = 3;
const MIN_FONT_SIZE = 44;
const FONT_STEP = 6;
const START_FONT_SIZE = 132;
const STROKE_WIDTH = 18; // 요구사항: 18px 두꺼운 아웃라인
const ACCENT_COLOR = "#F5FF00"; // 형광 노랑 — 가독성·클릭 유도용 강조 색

const FONT_FAMILY = "Thumbnail Noto Sans KR";
let fontsRegistered = false;

// 변수 폰트(weight 축 포함) 하나만 번들에 넣고, 그리기 시점에 font-weight
// 숫자로 원하는 굵기를 골라 쓴다 (900 = Black).
//
// 등록 실패를 조용히 넘기지 않는다 — 예전에 이 부분을 무시했을 때, 서버리스
// 배포 환경에서 폰트 파일을 못 찾았는데도 요청 자체는 "성공"해버려서 한글이
// 전부 네모(tofu)로 깨진 결과물이 그대로 저장된 적이 있다.
const registerFonts = (): void => {
  if (fontsRegistered) {
    return;
  }
  const fontPath = path.join(
    process.cwd(),
    "public/fonts/NotoSansKR-Variable.ttf",
  );
  const registered = GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  if (!registered) {
    throw new Error(
      `한글 폰트를 등록하지 못했습니다 (경로: ${fontPath}). 배포 환경에 폰트 파일이 ` +
        "포함되어 있는지 next.config.ts의 outputFileTracingIncludes 설정을 확인하세요.",
    );
  }
  fontsRegistered = true;
};

const coverDraw = (ctx: SKRSContext2D, img: Image): void => {
  const targetRatio = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  const srcRatio = img.width / img.height;

  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;

  if (srcRatio > targetRatio) {
    sw = img.height * targetRatio;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / targetRatio;
    sy = (img.height - sh) / 2;
  }

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
};

const drawTopGradient = (
  ctx: SKRSContext2D,
  heightRatio = 0.4,
  maxAlpha = 0.85,
): void => {
  const gradientHeight = THUMBNAIL_HEIGHT * heightRatio;
  const gradient = ctx.createLinearGradient(0, 0, 0, gradientHeight);
  gradient.addColorStop(0, `rgba(0, 0, 0, ${maxAlpha})`);
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, gradientHeight);
};

// 어절 단위로 줄을 나누되, 한 어절 자체가 한 줄 너비를 넘으면 글자 단위로 쪼갠다.
// 한국어 제목은 "노을을병에가둬버렸다고요ㅋㅋㅋ"처럼 띄어쓰기 없이 길게 쓰는 경우가
// 흔한데, 공백으로만 나누면 그런 제목이 한 줄에 그대로 남아 화면 밖으로 잘려 나간다
// (실제로 잘리는 걸 확인하고 고침).
const wrapText = (
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string[] => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [text];
  }

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }

    // 한 어절이 통째로 너비를 넘는 경우: 글자 단위로 끊어 담는다.
    let chunk = "";
    for (const char of Array.from(word)) {
      const nextChunk = chunk + char;
      if (ctx.measureText(nextChunk).width <= maxWidth) {
        chunk = nextChunk;
      } else {
        if (chunk) {
          lines.push(chunk);
        }
        chunk = char;
      }
    }
    current = chunk;
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [text];
};

type FitResult = { fontSize: number; lines: string[]; lineHeight: number };

const fitTitleText = (
  ctx: SKRSContext2D,
  text: string,
  startSize: number,
  maxWidth: number,
  maxBlockHeight: number,
): FitResult => {
  let fontSize = startSize;

  while (fontSize >= MIN_FONT_SIZE) {
    ctx.font = `900 ${fontSize}px "${FONT_FAMILY}"`;
    const lines = wrapText(ctx, text, maxWidth);
    const lineHeight = fontSize * 1.25;
    const blockHeight = lines.length * lineHeight;
    // 줄 수·높이뿐 아니라 실제 줄 너비까지 확인한다. 예전에는 너비를 안 봐서,
    // 쪼갤 수 없는 긴 제목이 그대로 한 줄에 남아 화면 밖으로 넘쳐도 통과됐다.
    const widestLine = Math.max(
      ...lines.map((line) => ctx.measureText(line).width),
    );

    if (
      lines.length <= MAX_TEXT_LINES &&
      blockHeight <= maxBlockHeight &&
      widestLine <= maxWidth
    ) {
      return { fontSize, lines, lineHeight };
    }
    fontSize -= FONT_STEP;
  }

  ctx.font = `900 ${MIN_FONT_SIZE}px "${FONT_FAMILY}"`;
  const lines = wrapText(ctx, text, maxWidth).slice(0, MAX_TEXT_LINES);
  return { fontSize: MIN_FONT_SIZE, lines, lineHeight: MIN_FONT_SIZE * 1.25 };
};

const drawTitleText = (
  ctx: SKRSContext2D,
  fit: FitResult,
  topY: number,
): void => {
  ctx.font = `900 ${fit.fontSize}px "${FONT_FAMILY}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";

  let y = topY + fit.fontSize;
  const x = THUMBNAIL_WIDTH / 2;

  for (const line of fit.lines) {
    // 1) 드롭 섀도우
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#000000";
    ctx.fillText(line, x, y);
    ctx.restore();

    // 2) 18px 굵은 외곽선
    ctx.lineWidth = STROKE_WIDTH;
    ctx.strokeStyle = "#000000";
    ctx.strokeText(line, x, y);

    // 3) 형광 노랑 채우기
    ctx.fillStyle = ACCENT_COLOR;
    ctx.fillText(line, x, y);

    y += fit.lineHeight;
  }
};

export type ComposeThumbnailOptions = {
  backgroundBytes: Buffer;
  titleText: string;
};

// 배경 이미지(바이트) + 문구를 합쳐 최종 9:16 썸네일 PNG 버퍼를 반환한다.
//
// 배경은 반드시 loadImage()로 디코딩해야 한다 — `new Image(); image.src = buffer`
// 방식은 WEBP 입력에서 width/height는 채워지면서도 실제 픽셀 디코딩은 조용히
// 실패해, 완전히 빈(투명) 이미지가 그려지는 문제를 실제로 겪었다(Flux 출력은
// 기본이 WEBP라 매번 걸리는 문제였음).
export const composeThumbnail = async ({
  backgroundBytes,
  titleText,
}: ComposeThumbnailOptions): Promise<Buffer> => {
  registerFonts();

  const image: Image = await loadImage(backgroundBytes);

  const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const ctx = canvas.getContext("2d");

  coverDraw(ctx, image);
  drawTopGradient(ctx);

  const maxTextWidth = THUMBNAIL_WIDTH - SIDE_MARGIN * 2;
  const maxBlockHeight = SAFE_BOTTOM_Y - TITLE_TOP_Y;
  const fit = fitTitleText(
    ctx,
    titleText,
    START_FONT_SIZE,
    maxTextWidth,
    maxBlockHeight,
  );
  drawTitleText(ctx, fit, TITLE_TOP_Y);

  return canvas.toBuffer("image/png");
};

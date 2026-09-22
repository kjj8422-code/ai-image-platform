import path from "node:path";
import {
  createCanvas,
  GlobalFonts,
  Image,
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
// 요구사항: 텍스트를 상단~중앙(Y축 450px 부근)에 배치.
const TITLE_TOP_Y = 450;
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
const registerFonts = (): void => {
  if (fontsRegistered) {
    return;
  }
  const fontPath = path.join(
    process.cwd(),
    "public/fonts/NotoSansKR-Variable.ttf",
  );
  GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
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
  heightRatio = 0.55,
  maxAlpha = 0.8,
): void => {
  const gradientHeight = THUMBNAIL_HEIGHT * heightRatio;
  const gradient = ctx.createLinearGradient(0, 0, 0, gradientHeight);
  gradient.addColorStop(0, `rgba(0, 0, 0, ${maxAlpha})`);
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, gradientHeight);
};

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
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
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

    if (lines.length <= MAX_TEXT_LINES && blockHeight <= maxBlockHeight) {
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
export const composeThumbnail = ({
  backgroundBytes,
  titleText,
}: ComposeThumbnailOptions): Buffer => {
  registerFonts();

  const image = new Image();
  image.src = backgroundBytes;

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

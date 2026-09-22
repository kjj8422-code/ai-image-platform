// 쇼츠/릴스 9:16 썸네일을 <canvas>에 합성하는 순수 브라우저 유틸리티.
// "use client" 컴포넌트에서만 호출해야 한다 (document/Image 등 브라우저 API 사용).

export const THUMBNAIL_WIDTH = 1080;
export const THUMBNAIL_HEIGHT = 1920;

// 쇼츠/릴스 플랫폼 UI가 실제로 가리는 영역 비율 (요구사항 3번 근거).
// 좌우 여백을 우측 세이프존 비율과 동일하게 맞춰서(대칭), 가운데 정렬된 문구가
// 우측 15% 안으로 절대 들어가지 않도록 만든다.
export const SAFE_ZONE = {
  bottomRatio: 0.25, // 하단 25%: 제목/채널정보/설명
  rightRatio: 0.15, // 우측 15%: 좋아요/댓글/공유 버튼
};

const SIDE_MARGIN = Math.round(THUMBNAIL_WIDTH * SAFE_ZONE.rightRatio);
const TOP_MARGIN = 220;
const SAFE_BOTTOM_Y = Math.round(
  THUMBNAIL_HEIGHT * (1 - SAFE_ZONE.bottomRatio),
);

const MAX_TEXT_LINES = 3;
const MIN_FONT_SIZE = 44;
const FONT_STEP = 6;

// layout.tsx에서 next/font/google로 등록한 --font-noto-sans-kr 변수를 읽어온다.
// next/font가 만들어내는 실제 폰트 패밀리명은 빌드마다 해시가 붙으므로 하드코딩하지 않는다.
const resolveFontFamily = (): string => {
  if (typeof document === "undefined") {
    return "sans-serif";
  }
  const variable = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-noto-sans-kr")
    .trim();
  return variable ? `${variable}, sans-serif` : "'Malgun Gothic', sans-serif";
};

// 웹폰트가 실제로 로드된 뒤 그려야 텍스트가 기본 폰트로 깨지지 않는다.
export const ensureFontReady = async (weight: number): Promise<void> => {
  const family = resolveFontFamily();
  try {
    await document.fonts.load(`${weight} 100px ${family}`);
  } catch {
    // 폰트 로드 실패해도 폴백 폰트로 계속 진행 (치명적 에러로 취급하지 않음)
  }
};

export const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    // toDataURL()로 내보낼 때 캔버스가 "오염(tainted)"되지 않도록 CORS 허용 요청.
    // /edit/[id] 페이지에서 이미 같은 방식으로 검증된 패턴.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = url;
  });

const coverDraw = (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => {
  const targetRatio = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  const srcRatio = img.naturalWidth / img.naturalHeight;

  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;

  if (srcRatio > targetRatio) {
    sw = img.naturalHeight * targetRatio;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / targetRatio;
    sy = (img.naturalHeight - sh) / 2;
  }

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
};

const drawTopGradient = (
  ctx: CanvasRenderingContext2D,
  heightRatio = 0.5,
  maxAlpha = 0.75,
) => {
  const gradientHeight = THUMBNAIL_HEIGHT * heightRatio;
  const gradient = ctx.createLinearGradient(0, 0, 0, gradientHeight);
  gradient.addColorStop(0, `rgba(0, 0, 0, ${maxAlpha})`);
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, gradientHeight);
};

const wrapText = (
  ctx: CanvasRenderingContext2D,
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

// 세이프존(하단 25%) 위쪽 공간 안에 최대 3줄로 들어갈 때까지 글자 크기를 줄여간다.
const fitTitleText = (
  ctx: CanvasRenderingContext2D,
  fontFamily: string,
  text: string,
  startSize: number,
  maxWidth: number,
  maxBlockHeight: number,
): FitResult => {
  let fontSize = startSize;

  while (fontSize >= MIN_FONT_SIZE) {
    ctx.font = `900 ${fontSize}px ${fontFamily}`;
    const lines = wrapText(ctx, text, maxWidth);
    const lineHeight = fontSize * 1.25;
    const blockHeight = lines.length * lineHeight;

    if (lines.length <= MAX_TEXT_LINES && blockHeight <= maxBlockHeight) {
      return { fontSize, lines, lineHeight };
    }
    fontSize -= FONT_STEP;
  }

  ctx.font = `900 ${MIN_FONT_SIZE}px ${fontFamily}`;
  const lines = wrapText(ctx, text, maxWidth).slice(0, MAX_TEXT_LINES);
  return { fontSize: MIN_FONT_SIZE, lines, lineHeight: MIN_FONT_SIZE * 1.25 };
};

const drawTitleText = (
  ctx: CanvasRenderingContext2D,
  fontFamily: string,
  fit: FitResult,
  topY: number,
) => {
  ctx.font = `900 ${fit.fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";

  let y = topY + fit.fontSize;
  const x = THUMBNAIL_WIDTH / 2;

  for (const line of fit.lines) {
    // 1) 그림자
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#000000";
    ctx.fillText(line, x, y);
    ctx.restore();

    // 2) 굵은 외곽선
    ctx.lineWidth = Math.max(6, fit.fontSize * 0.09);
    ctx.strokeStyle = "#000000";
    ctx.strokeText(line, x, y);

    // 3) 흰색 채우기
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(line, x, y);

    y += fit.lineHeight;
  }
};

export type RenderThumbnailOptions = {
  backgroundImage: HTMLImageElement;
  titleText: string;
  fontSize?: number;
};

// 배경 이미지 + 문구를 합쳐 최종 9:16 썸네일을 그린다.
export const renderThumbnail = (
  canvas: HTMLCanvasElement,
  { backgroundImage, titleText, fontSize = 132 }: RenderThumbnailOptions,
): void => {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("캔버스를 초기화하지 못했습니다.");
  }

  const fontFamily = resolveFontFamily();

  ctx.clearRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  coverDraw(ctx, backgroundImage);
  drawTopGradient(ctx);

  const maxTextWidth = THUMBNAIL_WIDTH - SIDE_MARGIN * 2;
  const maxBlockHeight = SAFE_BOTTOM_Y - TOP_MARGIN;
  const fit = fitTitleText(
    ctx,
    fontFamily,
    titleText,
    fontSize,
    maxTextWidth,
    maxBlockHeight,
  );
  drawTitleText(ctx, fontFamily, fit, TOP_MARGIN);
};

// 세이프존을 시각화하는 참고용 가이드(빨간 반투명 영역). 최종 저장 결과물에는 포함되지 않고
// 편집 화면 미리보기에서만 별도 캔버스로 겹쳐 보여준다.
export const renderSafeZoneOverlay = (canvas: HTMLCanvasElement): void => {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  ctx.fillStyle = "rgba(239, 68, 68, 0.28)";

  // 하단 25% (제목/채널정보 영역)
  ctx.fillRect(
    0,
    SAFE_BOTTOM_Y,
    THUMBNAIL_WIDTH,
    THUMBNAIL_HEIGHT - SAFE_BOTTOM_Y,
  );
  // 우측 15% (좋아요/댓글/공유 버튼 영역)
  ctx.fillRect(THUMBNAIL_WIDTH - SIDE_MARGIN, 0, SIDE_MARGIN, THUMBNAIL_HEIGHT);
};

"use client";

// 업로드 전에 브라우저에서 사진을 줄인다. 폰 사진 한 장은 3~5MB이고 base64로
// 바꾸면 거기서 1.33배가 더 붙어서, 원본 6장을 한 번에 보내면 Vercel의 요청 본문
// 상한(4.5MB)을 훌쩍 넘긴다. 그러면 서버는 JSON이 아닌 "Request Entity Too Large"
// 평문을 돌려주고, 화면에는 원인을 알 수 없는 JSON 파싱 오류만 남는다.
// 줄여 보내면 그 한계를 피하는 동시에 Claude가 읽는 픽셀 수도 줄어 비전 토큰
// 비용까지 같이 내려간다. 쇼츠는 세로 1080 기준이라 1280px이면 화질 손해가 없다.
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

type LoadedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

// 폰 사진은 회전 정보가 EXIF에만 들어 있어서, 그냥 그리면 눕거나 뒤집힌 채로 올라간다.
const loadImage = async (file: File): Promise<LoadedImage> => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // 이 옵션을 거부하는 브라우저가 있다. 아래 <img> 경로로 넘어간다.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new Error(`${file.name} 을(를) 읽지 못했습니다.`));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
};

export const downscaleToDataUrl = async (file: File): Promise<string> => {
  const image = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error(`${file.name} 을(를) 변환하지 못했습니다.`);
    }
    ctx.drawImage(image.source, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    image.release();
  }
};

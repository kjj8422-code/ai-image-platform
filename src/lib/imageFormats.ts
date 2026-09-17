// 납품 규격 프리셋.
//
// 지금까지는 Flux에 크기를 아무것도 넘기지 않아 모델 기본값인 정사각형(1024x1024)
// 한 종류만 나왔다. 정사각형을 잘라 16:9 썸네일로 쓰면 한 변이 1024 → 576으로
// 줄어 유튜브 권장 규격(1280x720)에 미달한다. 그래서 자르는 대신 처음부터
// 규격에 맞는 비율로 생성한다.
//
// Flux 1.1 Pro는 픽셀 수와 무관하게 장당 정액 과금이라, 비율을 지정해도
// 추가 비용이 발생하지 않는다.
// hint는 "생성되는 비율"이다. 최종 출력 픽셀 수는 모델이 정하므로
// 여기에 특정 픽셀 값을 적어 약속하지 않는다.
export const IMAGE_FORMATS = [
  {
    id: "thumbnail",
    label: "유튜브 · SNS 썸네일",
    ratio: "16:9",
    hint: "16:9 가로형",
  },
  { id: "detail", label: "상세페이지", ratio: "4:5", hint: "4:5 세로형" },
  { id: "square", label: "대표이미지", ratio: "1:1", hint: "1:1 정사각" },
  { id: "story", label: "릴스 · 스토리", ratio: "9:16", hint: "9:16 세로형" },
  { id: "banner", label: "광고 배너", ratio: "3:2", hint: "3:2 가로형" },
] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export type ImageFormatId = ImageFormat["id"];

// 화면과 API가 같은 기본값을 쓰도록 여기서 한 번만 정한다.
export const DEFAULT_FORMAT_ID: ImageFormatId = "thumbnail";

const RATIO_BY_ID: Record<ImageFormatId, string> = IMAGE_FORMATS.reduce(
  (acc, format) => ({ ...acc, [format.id]: format.ratio }),
  {} as Record<ImageFormatId, string>,
);

// 요청으로 들어온 규격 id를 Flux의 aspect_ratio 값으로 바꾼다.
// 목록에 없는 값이면 null을 돌려주고, 라우트에서 400으로 거른다.
export const resolveAspectRatio = (formatId: unknown): string | null => {
  if (typeof formatId !== "string") {
    return null;
  }
  return RATIO_BY_ID[formatId as ImageFormatId] ?? null;
};

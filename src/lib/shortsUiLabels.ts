import type { BgmMood } from "@/lib/audioCatalog";
import type { SceneStyle } from "@/lib/characterShorts";

// AI 영상 쇼츠 화면과 캐릭터 쇼츠 화면이 같은 스타일/BGM/효과음 어휘를 쓰므로
// 여기 한 곳에 모아 공유한다(화면마다 따로 번역 문구를 두면 서로 어긋나기 쉽다).

export const STYLE_OPTIONS: { value: SceneStyle; label: string }[] = [
  { value: "comic", label: "코믹 썰" },
  { value: "jeju_travel", label: "제주 여행 소개" },
  { value: "emotional", label: "감성 영상" },
  { value: "product_ad", label: "제품 광고" },
];

// build_shorts.py의 BGM_DIR에 있는 무드 중 스타일과 톤이 가까운 것을 기본값으로
// 고른다. 화면에서 직접 바꿀 수도 있다.
export const BGM_MOOD_BY_STYLE: Record<SceneStyle, BgmMood> = {
  comic: "playful",
  jeju_travel: "epic",
  emotional: "dreamy",
  product_ad: "epic",
};

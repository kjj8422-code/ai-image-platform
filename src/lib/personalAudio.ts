export type PersonalAudio = {
  id: string;
  title: string;
  artist: string;
  genre: string;
  mood: string;
  kind: "bgm" | "sfx";
  duration: number;
  classification: "estimated" | "manual";
  attribution: string;
};

export const AUDIO_GENRES = ["팝", "힙합", "일렉트로닉", "록", "어쿠스틱", "재즈·소울", "시네마틱", "환경음·효과음", "미분류"];
export const AUDIO_MOODS = ["밝음·경쾌", "차분·편안", "감성·따뜻", "긴장·어두움", "웅장·강렬", "몽환·신비", "미분류"];

// Match the existing storyboard direction without changing its voice/style family.
export function recommendedAudioMood(mood: string): string {
  if (["playful", "upbeat", "travel", "retro"].includes(mood)) return "밝음·경쾌";
  if (["chill", "documentary"].includes(mood)) return "차분·편안";
  if (["warm", "romantic", "sad"].includes(mood)) return "감성·따뜻";
  if (["horror", "mystery"].includes(mood)) return "긴장·어두움";
  if (["epic", "action", "inspiring"].includes(mood)) return "웅장·강렬";
  return "몽환·신비";
}

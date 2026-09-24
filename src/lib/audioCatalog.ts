import catalog from "./audioCatalog.json" with { type: "json" };

// 효과음·배경음악 목록은 웹(고르는 화면·AI 대본)과 PC의 build_shorts.py(실제 mp3를
// 찾아 섞는 쪽)가 같이 본다. 한쪽에만 이름을 추가하면 웹에서 고른 소리가 PC에서
// 조용히 빠지므로, 이름·설명은 audioCatalog.json 한 군데에만 적고 양쪽이 그걸 읽는다.
//
// 아래 두 목록은 타입(zod enum, SfxCue)을 만들려고 이름만 한 번 더 적은 것이다.
// JSON과 어긋나면 audioCatalog.test.ts가 잡는다.

export const SFX_LIBRARY = [
  "boom",
  "suspense",
  "reveal",
  "whoosh",
  "pop",
  "magic",
  "laugh",
  "coin",
  "levelup",
  "fanfare",
  "fail",
  "buzzer",
  "boing",
  "impact",
  "thud",
  "alarm",
  "triumph",
  "ding",
  "sparkle",
  "chime",
  "bell",
  "message",
  "splash",
  "click",
  "my1",
  "my2",
  "my3",
  "none",
] as const;

export type SfxCue = (typeof SFX_LIBRARY)[number];

export const BGM_MOODS = [
  "mystery",
  "epic",
  "playful",
  "dreamy",
  "horror",
  "sad",
  "upbeat",
  "chill",
  "action",
  "retro",
  "my1",
  "my2",
] as const;

export type BgmMood = (typeof BGM_MOODS)[number];

type SfxEntry = { cue: string; group: string; label: string; hint?: string };
type BgmEntry = { mood: string; family: string; group: string; label: string; hint?: string };

export const SFX_ENTRIES: readonly SfxEntry[] = catalog.sfx;
export const BGM_ENTRIES: readonly BgmEntry[] = catalog.bgm;

const sfxByCue = new Map(SFX_ENTRIES.map((entry) => [entry.cue, entry]));
const bgmByMood = new Map(BGM_ENTRIES.map((entry) => [entry.mood, entry]));

export const sfxLabel = (cue: string): string => sfxByCue.get(cue)?.label ?? cue;
export const bgmLabel = (mood: string): string => bgmByMood.get(mood)?.label ?? mood;

// <optgroup>으로 묶어 보여주기 위한 순서 유지 그룹핑. 28개를 한 줄로 늘어놓으면
// 원하는 소리를 찾기 어렵다.
const groupInOrder = <T extends { group: string }>(entries: readonly T[]) => {
  const groups: { group: string; items: T[] }[] = [];
  for (const entry of entries) {
    const last = groups.find((g) => g.group === entry.group);
    if (last) last.items.push(entry);
    else groups.push({ group: entry.group, items: [entry] });
  }
  return groups;
};

export const SFX_GROUPS = groupInOrder(SFX_ENTRIES);
export const BGM_GROUPS = groupInOrder(BGM_ENTRIES);

// AI에게는 hint가 있는 것만 보여준다. "내 효과음"이나 직접 넣는 음악 칸은
// 사장님 PC에 파일이 있는지 웹에서 알 수 없어서, AI가 골랐다가 빈 칸이면
// 소리가 통째로 빠진다. 그런 칸은 사람이 화면에서 직접 고를 때만 쓴다.
// (JSON의 이름이 위 두 목록 안에 있다는 건 audioCatalog.test.ts가 보장한다.)
export const AI_SFX_CUES = SFX_ENTRIES.filter((e) => e.hint).map(
  (e) => e.cue,
) as [SfxCue, ...SfxCue[]];
export const AI_BGM_MOODS = BGM_ENTRIES.filter((e) => e.hint).map(
  (e) => e.mood,
) as [BgmMood, ...BgmMood[]];

export const aiSfxMenu = (): string =>
  SFX_ENTRIES.filter((e) => e.hint)
    .map((e) => `${e.cue} (${e.hint})`)
    .join(", ");

export const aiBgmMenu = (): string =>
  BGM_ENTRIES.filter((e) => e.hint)
    .map((e) => `${e.mood} (${e.hint})`)
    .join(", ");

import { SFX_ENTRIES, type SfxCue } from "./audioCatalog.ts";

export const SFX_TIMINGS = ["start", "middle", "end"] as const;
export type SfxTiming = (typeof SFX_TIMINGS)[number];
export const isAudioBed = (cue: string) =>
  SFX_ENTRIES.some((entry) => entry.cue === cue && entry.playback === "bed");

export const AUDIO_DIRECTION = `
【사운드 연출】
- BGM은 전체 이야기의 주된 감정과 속도에 맞춘다. 여행/일상은 travel/chill/warm, 정보 전달은 documentary, 애틋함은 sad/romantic, 장난은 playful, 실제 위기만 action/horror를 고려한다. 장르를 무작위로 고르지 마라.
- sfx는 사진에 보이는 행동과 해당 대사의 의미에 맞춰 고른다. 첫 장면이라고 boom, 마지막이라고 laugh를 넣지 마라.
- 충격음(boom/impact/alarm/triumph/fanfare)은 꼭 필요한 강조에만, 전체 최대 2번. 일반 설명 장면에는 none을 적극 사용한다. 같은 효과음은 연속으로 쓰지 않는다. 감성 영상에 코믹 웃음/경고음을 넣지 마라.
- 반전을 미리 누설하지 마라. 기대를 끄는 장면에는 ticking/heartbeat/riser, 공개한 뒤에는 reveal/success/glimmer 등을 의미에 맞게 쓴다.
- sfxTiming은 start(사진 전환/행동 시작), middle(장면 중간 강조), end(대사 뒤 반응/다음 장면 직전 긴장) 중 하나. 웃음·허탈한 반응은 end, 전환·셔터는 start가 자연스럽다.
- 환경음 rain/wind/waves/birds/fire/night는 해당 환경이 사진이나 대본에 실제로 있을 때만 쓴다. 장면 전체에 깔리므로 sfxTiming은 start.
`;

const HEAVY = new Set(["boom", "impact", "alarm", "triumph", "fanfare"]);
const END_CUES = new Set(["laugh", "fail", "buzzer", "boing", "downer", "riser"]);

// Only generated boards are normalized. Manual edits remain authoritative.
export function directGeneratedAudio<T extends { sfx: SfxCue; sfxTiming?: string }>(scenes: T[]) {
  let previous: SfxCue = "none";
  let heavyCount = 0;
  return scenes.map((scene) => {
    let cue = scene.sfx;
    if (cue !== "none" && !isAudioBed(cue) && cue === previous) cue = "none";
    if (HEAVY.has(cue) && ++heavyCount > 2) cue = "none";
    const timing: SfxTiming = isAudioBed(cue) || cue === "none"
      ? "start"
      : SFX_TIMINGS.includes(scene.sfxTiming as SfxTiming)
        ? scene.sfxTiming as SfxTiming
        : END_CUES.has(cue) ? "end" : "start";
    previous = cue;
    return { ...scene, sfx: cue, sfxTiming: timing };
  });
}

// Pure editing rules shared by the UI and server; no paid model calls.
export function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function isExactSceneOrder(currentIds: string[], order: unknown): order is string[] {
  return Array.isArray(order) && order.length === currentIds.length &&
    new Set(order).size === currentIds.length && order.every(id => typeof id === "string" && currentIds.includes(id));
}

export type VisualDirection = { keyAction: string | null; cameraMotion: string | null; preserveNotes: string | null };
export const VISUAL_LIMITS = { keyAction: 300, cameraMotion: 80, preserveNotes: 100 } as const;
export function composeEditedVisualPrompt(scene: VisualDirection): string {
  return `${scene.keyAction ?? ""}. Camera: ${scene.cameraMotion ?? "static shot"}. Keep unchanged: ${scene.preserveNotes ?? "identity, clothing, objects, lighting in the source image"}. Single continuous shot. No added captions or narration text in the image.`;
}

export function withSceneContinuity(prompt: string, previous?: VisualDirection, next?: VisualDirection): string {
  // Runway limits promptText to 1,000 UTF-16 code units. Never truncate user directions.
  if (prompt.length > 1000) throw new Error("장면 생성 설명이 너무 깁니다. 장면 설명·카메라·유지할 요소를 짧게 수정한 뒤 저장하세요.");
  let result = prompt;
  const append = (note: string) => { if (result.length + note.length + 1 <= 1000) result += `\n${note}`; };
  append("Smooth cuts: preserve identity and screen direction where compatible. Settle at end. No morphing.");
  if (previous?.cameraMotion) append(`Previous camera: ${previous.cameraMotion}.`);
  if (next?.cameraMotion) append(`Next camera: ${next.cameraMotion}.`);
  if (previous?.keyAction) append(`Previous action: ${previous.keyAction}.`);
  if (next?.keyAction) append(`Next action: ${next.keyAction}.`);
  return result;
}

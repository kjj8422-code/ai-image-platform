export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export const UPLOADED_CLIP_MODEL = "uploaded-video";
export function validClipFile(name: string, size: number) {
  return /\.mp4$/i.test(name) && Number.isInteger(size) && size > 0 && size <= MAX_CLIP_BYTES;
}
export function ownsClipPath(path: unknown, userId: string, sceneId: string): path is string {
  if (typeof path !== "string") return false;
  const prefix = `${userId}/scene-uploads/${sceneId}/`;
  return path.startsWith(prefix) && /^[a-f0-9-]{36}\.mp4$/.test(path.slice(prefix.length));
}

import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// 공급자 임시 URL(Runway 기준 24~48시간 뒤 만료)을 우리 Supabase Storage로 옮겨
// 영구 URL로 바꾼다. gallery 버킷은 MIME 제한이 없어 그대로 재사용한다
// (video-clips/ 하위 경로로 이미지와 분리).
export const persistVideoClip = async (
  userId: string,
  sceneId: string,
  providerRawUrl: string,
): Promise<string> => {
  const response = await fetch(providerRawUrl);
  if (!response.ok) {
    throw new Error("생성된 영상을 가져오지 못했습니다.");
  }

  const contentType = response.headers.get("content-type") ?? "video/mp4";
  const extension = contentType.includes("mp4")
    ? "mp4"
    : contentType.includes("webm")
      ? "webm"
      : contentType.includes("png") // MockVideoProvider 검증용 경로
        ? "png"
        : "mp4";
  const bytes = await response.arrayBuffer();
  const path = `${userId}/video-clips/${sceneId}-${randomUUID()}.${extension}`;

  const supabaseAdmin = getSupabaseAdmin();
  const { error: uploadError } = await supabaseAdmin.storage
    .from("gallery")
    .upload(path, Buffer.from(bytes), { contentType, upsert: false });
  if (uploadError) {
    throw uploadError;
  }

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from("gallery").getPublicUrl(path);
  return publicUrl;
};

import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type GalleryImageSource = "generated" | "remix" | "inpaint" | "thumbnail";

export type GalleryImage = {
  id: string;
  imageUrl: string;
  prompt: string | null;
  source: string;
  createdAt: string;
};

type GalleryImageRow = {
  id: string;
  image_url: string;
  prompt: string | null;
  source: string;
  created_at: string;
};

const toGalleryImage = (row: GalleryImageRow): GalleryImage => ({
  id: row.id,
  imageUrl: row.image_url,
  prompt: row.prompt,
  source: row.source,
  createdAt: row.created_at,
});

// Replicate가 생성한 이미지는 일정 기간 후 삭제될 수 있어(임시 CDN), "저장"을
// 누르면 실제 파일을 다운로드해서 우리 Supabase Storage에 영구 보관한다.
export const saveImageToGallery = async (
  userId: string,
  sourceImageUrl: string,
  prompt: string,
  source: GalleryImageSource,
): Promise<GalleryImage> => {
  const response = await fetch(sourceImageUrl);
  if (!response.ok) {
    throw new Error("원본 이미지를 가져오지 못했습니다.");
  }

  const contentType = response.headers.get("content-type") ?? "image/png";
  const bytes = await response.arrayBuffer();

  const extension = contentType.includes("webp")
    ? "webp"
    : contentType.includes("jpeg")
      ? "jpg"
      : "png";
  const path = `${userId}/${randomUUID()}.${extension}`;
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

  const { data, error } = await supabaseAdmin
    .from("gallery_images")
    .insert({ user_id: userId, image_url: publicUrl, prompt, source })
    .select("id, image_url, prompt, source, created_at")
    .single();
  if (error) {
    throw error;
  }

  return toGalleryImage(data as GalleryImageRow);
};

// 원격 URL이 아니라 브라우저 <canvas>에서 만든 "data:image/png;base64,..." 같은
// 데이터 URL을 그대로 Supabase Storage에 업로드한다 (쇼츠 썸네일처럼 클라이언트에서
// 합성이 끝난 최종 이미지를 저장할 때 사용).
export const saveDataUrlToGallery = async (
  userId: string,
  dataUrl: string,
  prompt: string,
  source: GalleryImageSource,
): Promise<GalleryImage> => {
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    throw new Error("이미지 데이터 형식이 올바르지 않습니다.");
  }
  const [, contentType, base64] = match;
  const bytes = Buffer.from(base64, "base64");

  const extension = contentType.includes("webp")
    ? "webp"
    : contentType.includes("jpeg")
      ? "jpg"
      : "png";
  const path = `${userId}/${randomUUID()}.${extension}`;
  const supabaseAdmin = getSupabaseAdmin();

  const { error: uploadError } = await supabaseAdmin.storage
    .from("gallery")
    .upload(path, bytes, { contentType, upsert: false });
  if (uploadError) {
    throw uploadError;
  }

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from("gallery").getPublicUrl(path);

  const { data, error } = await supabaseAdmin
    .from("gallery_images")
    .insert({ user_id: userId, image_url: publicUrl, prompt, source })
    .select("id, image_url, prompt, source, created_at")
    .single();
  if (error) {
    throw error;
  }

  return toGalleryImage(data as GalleryImageRow);
};

export const listGalleryImages = async (
  userId: string,
): Promise<GalleryImage[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from("gallery_images")
    .select("id, image_url, prompt, source, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }

  return ((data ?? []) as GalleryImageRow[]).map(toGalleryImage);
};

// 리믹스(합성) 요청 시, 사용자가 고른 이미지가 정말 "본인 소유"인지 함께 검증한다
// (다른 사람 갤러리 이미지 id를 넘겨 무단으로 참고하는 걸 막기 위함).
export const getOwnedGalleryImages = async (
  userId: string,
  ids: string[],
): Promise<GalleryImage[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from("gallery_images")
    .select("id, image_url, prompt, source, created_at")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) {
    throw error;
  }

  return ((data ?? []) as GalleryImageRow[]).map(toGalleryImage);
};

import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";

// 생성 이미지 한 장은 보통 1~5MB다. 이보다 훨씬 큰 건 이미지가 아닐 가능성이 높다.
const MAX_SAVE_BYTES = 30 * 1024 * 1024;

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
  // 서버가 받아 오는 주소는 우리가 실제로 이미지를 두는 곳(Replicate CDN, 우리
  // Supabase)으로만 제한한다. 아무 주소나 받아 주면 서버를 통해 내부망 주소를
  // 들여다보는 통로(SSRF)가 된다 — /api/download와 같은 허용 목록을 쓴다.
  const target = parseAllowedImageUrl(
    sourceImageUrl,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  if (!target) {
    throw new Error("허용되지 않은 이미지 주소입니다.");
  }

  const response = await fetch(target.toString());
  if (!response.ok) {
    throw new Error("원본 이미지를 가져오지 못했습니다.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error("이미지 파일이 아닙니다.");
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_SAVE_BYTES) {
    throw new Error("이미지가 너무 큽니다.");
  }
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

// 쇼츠 소재로 올린 이미지는 "작품"이 아니라 재료라서 갤러리 목록에는 넣지 않고
// 스토리지에만 올린다(DB 스키마를 건드리지 않아도 되고, 갤러리도 안 지저분해진다).
export const uploadSourceImage = async (
  userId: string,
  dataUrl: string,
): Promise<string> => {
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
  const path = `${userId}/sources/${randomUUID()}.${extension}`;
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
  return publicUrl;
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

// 공개 URL(.../storage/v1/object/public/gallery/<경로>)에서 스토리지 경로만 꺼낸다.
const STORAGE_PUBLIC_MARKER = "/storage/v1/object/public/gallery/";

export const storagePathFromPublicUrl = (publicUrl: string): string | null => {
  const at = publicUrl.indexOf(STORAGE_PUBLIC_MARKER);
  if (at === -1) {
    return null;
  }
  const path = decodeURIComponent(publicUrl.slice(at + STORAGE_PUBLIC_MARKER.length));
  return path || null;
};

// 갤러리 이미지 1장을 지운다. 본인 것만 지울 수 있고, 목록(DB)과 실제 파일을 둘 다
// 지운다. 파일 삭제가 실패해도 목록에서는 사라지게 한다 — 사용자 입장에서는 목록이
// 기준이고, 남은 파일은 공간만 조금 차지할 뿐 다시 보이지 않는다.
export const deleteGalleryImage = async (
  userId: string,
  id: string,
): Promise<boolean> => {
  const [owned] = await getOwnedGalleryImages(userId, [id]);
  if (!owned) {
    return false;
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin
    .from("gallery_images")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) {
    throw error;
  }

  const path = storagePathFromPublicUrl(owned.imageUrl);
  // 다른 사람 폴더의 파일은 절대 건드리지 않는다.
  if (path && path.startsWith(`${userId}/`)) {
    const { error: removeError } = await supabaseAdmin.storage
      .from("gallery")
      .remove([path]);
    if (removeError) {
      console.error("갤러리 파일 삭제 실패(목록에서는 지움):", removeError);
    }
  }
  return true;
};

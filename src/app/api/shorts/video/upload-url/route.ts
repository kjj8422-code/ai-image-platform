import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { MAX_IMAGES } from "@/lib/shortsFromImages";

export const maxDuration = 30;

const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

// AI 영상 쇼츠는 사진 쇼츠와 달리 브라우저에서 1280px로 축소하지 않고 원본 화질을
// 그대로 쓴다(영상 생성 모델에 넣을 입력이라 화질이 곧 결과 품질이다). 문제는
// 원본 사진 5~15장을 우리 서버(Vercel 서버리스 함수, 요청 본문 상한 4.5MB)를
// 거쳐 올리면 금방 그 상한을 넘긴다는 것 — 그래서 서버는 "여기에 직접 올려도 된다"는
// 서명된 업로드 URL만 발급하고, 실제 파일 바이트는 브라우저가 Supabase Storage로
// 곧장 보낸다(우리 서버를 거치지 않음).
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const rawExtensions: unknown = body?.extensions;
    const extensions = Array.isArray(rawExtensions)
      ? rawExtensions.filter((v): v is string => typeof v === "string")
      : [];

    if (extensions.length === 0 || extensions.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: `한 번에 1~${MAX_IMAGES}개의 업로드 URL만 요청할 수 있습니다.` },
        { status: 400 },
      );
    }
    if (!extensions.every((ext) => ALLOWED_EXTENSIONS.has(ext.toLowerCase()))) {
      return NextResponse.json(
        { error: "지원하지 않는 이미지 형식이 포함되어 있습니다." },
        { status: 400 },
      );
    }

    const supabaseAdmin = getSupabaseAdmin();
    const uploads = await Promise.all(
      extensions.map(async (extension) => {
        const path = `${auth.user.id}/sources-hq/${randomUUID()}.${extension.toLowerCase()}`;
        const { data, error } = await supabaseAdmin.storage
          .from("gallery")
          .createSignedUploadUrl(path);
        if (error) throw error;
        const {
          data: { publicUrl },
        } = supabaseAdmin.storage.from("gallery").getPublicUrl(path);
        return { path, token: data.token, publicUrl };
      }),
    );

    return NextResponse.json({ uploads });
  } catch (err) {
    console.error("업로드 URL 발급 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

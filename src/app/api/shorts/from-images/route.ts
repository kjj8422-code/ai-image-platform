import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";
import {
  MAX_IMAGES,
  MIN_IMAGES,
  MissingAnthropicKeyError,
  generateStoryboardFromImages,
  resolveSceneCount,
} from "@/lib/shortsFromImages";

// 사진 10장 이상에 장면을 8~9개로 고르면 AI가 대본을 쓰는 데 1분을 넘길 수 있다.
// 60초로 두면 다 써 가던 대본이 중간에 끊겨 아무것도 못 받는다(돈은 이미 나감).
// Vercel Fluid compute 기준 무료 플랜 최대치가 300초다.
export const maxDuration = 300;

// 업로드된 이미지 5~10장을 Claude가 직접 보고 B급 썰체 시나리오를 만든다.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const rawUrls: unknown = body?.imageUrls;
    const imageUrls = Array.isArray(rawUrls)
      ? rawUrls.filter((url): url is string => typeof url === "string")
      : [];

    if (imageUrls.length < MIN_IMAGES || imageUrls.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: `이미지를 ${MIN_IMAGES}~${MAX_IMAGES}장 올려주세요.` },
        { status: 400 },
      );
    }

    // 임의의 주소를 Claude에 그대로 넘기면 우리 서버가 외부 주소를 대신 읽어주는
    // 통로가 된다. 다른 라우트와 같은 허용 목록(우리 스토리지 / Replicate CDN)만 받는다.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const allowed = imageUrls.every((url) =>
      Boolean(parseAllowedImageUrl(url, supabaseUrl)),
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "허용되지 않은 이미지 주소가 포함되어 있습니다." },
        { status: 400 },
      );
    }

    // 사용자가 장면 수를 골랐으면 그대로, "AI가 정하기"면 null.
    const sceneCount = resolveSceneCount(body?.sceneCount, imageUrls.length);
    const storyboard = await generateStoryboardFromImages(imageUrls, sceneCount);
    return NextResponse.json(storyboard);
  } catch (err) {
    console.error("이미지 기반 시나리오 생성 오류:", err);
    if (err instanceof MissingAnthropicKeyError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    const message =
      err instanceof Error
        ? err.message
        : "시나리오 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

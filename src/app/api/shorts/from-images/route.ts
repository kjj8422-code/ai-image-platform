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

export const maxDuration = 60;

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

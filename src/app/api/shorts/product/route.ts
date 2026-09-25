import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";
import { MissingAnthropicKeyError } from "@/lib/shortsFromImages";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_PRODUCT_IMAGES,
  MAX_REVIEWS_CHARS,
  MIN_PRODUCT_IMAGES,
  MIN_REVIEWS_CHARS,
  generateProductScript,
} from "@/lib/productShorts";

// 사진과 후기가 많으면 1분을 넘길 수 있다(from-images 라우트와 같은 이유).
export const maxDuration = 300;

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

// 쿠팡 꿀템 쇼츠 대본: 상품 사진 + 설명 + 실제 구매 후기 -> 장면·후기 카드·업로드 문구.
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
    if (imageUrls.length < MIN_PRODUCT_IMAGES || imageUrls.length > MAX_PRODUCT_IMAGES) {
      return NextResponse.json(
        { error: `상품 사진을 ${MIN_PRODUCT_IMAGES}~${MAX_PRODUCT_IMAGES}장 올려주세요.` },
        { status: 400 },
      );
    }

    // 다른 라우트와 같은 이유로, 우리 스토리지에 올린 사진 주소만 AI에 넘긴다.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!imageUrls.every((url) => Boolean(parseAllowedImageUrl(url, supabaseUrl)))) {
      return NextResponse.json(
        { error: "허용되지 않은 이미지 주소가 포함되어 있습니다." },
        { status: 400 },
      );
    }

    const reviews = text(body?.reviews, MAX_REVIEWS_CHARS);
    if (reviews.length < MIN_REVIEWS_CHARS) {
      return NextResponse.json(
        { error: "구매 후기를 붙여 넣어 주세요. 후기가 이 영상의 핵심이에요." },
        { status: 400 },
      );
    }

    // 링크는 설명란에 그대로 들어가므로 http(s) 주소만 받는다.
    const rawLink = text(body?.link, 500);
    const link = /^https?:\/\/\S+$/.test(rawLink) ? rawLink : "";

    const script = await generateProductScript({
      imageUrls,
      productName: text(body?.productName, 200),
      price: text(body?.price, 50),
      description: text(body?.description, MAX_DESCRIPTION_CHARS),
      reviews,
      link,
    });
    return NextResponse.json(script);
  } catch (err) {
    console.error("쿠팡 꿀템 쇼츠 대본 생성 오류:", err);
    if (err instanceof MissingAnthropicKeyError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    const message =
      err instanceof Error ? err.message : "대본 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

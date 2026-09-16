import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { CREDIT_PACK } from "@/lib/creditPricing";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

// 로그인한 사용자를 위해 Stripe Checkout 세션(결제 페이지)을 하나 만들어 그 URL을
// 돌려준다. 실제 크레딧 지급은 결제 완료 후 Stripe가 보내는 웹훅에서 처리한다
// (사용자가 결제 페이지를 그냥 닫아버려도 크레딧이 잘못 지급되지 않도록).
export async function POST(request: NextRequest) {
  try {
    if (!supabaseUrl || !supabasePublishableKey) {
      return NextResponse.json(
        { error: "서버 설정 오류: Supabase 환경변수가 누락되었습니다." },
        { status: 500 },
      );
    }

    if (!stripeSecretKey) {
      return NextResponse.json(
        { error: "서버 설정 오류: Stripe 키가 누락되었습니다." },
        { status: 500 },
      );
    }

    const authHeader = request.headers.get("authorization");
    const accessToken = authHeader?.replace("Bearer ", "");

    if (!accessToken) {
      return NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const supabase = createClient(supabaseUrl, supabasePublishableKey);
    const { data: userData, error: userError } =
      await supabase.auth.getUser(accessToken);

    if (userError || !userData.user) {
      return NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const stripe = new Stripe(stripeSecretKey);
    const origin = request.nextUrl.origin;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "krw",
            product_data: { name: CREDIT_PACK.productName },
            unit_amount: CREDIT_PACK.priceKrw,
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/generate?checkout=success`,
      cancel_url: `${origin}/generate?checkout=cancel`,
      // 웹훅에서 "누구에게 크레딧을 줄지" 알 수 있도록 사용자 id를 실어 보낸다.
      metadata: {
        userId: userData.user.id,
        credits: String(CREDIT_PACK.credits),
      },
    });

    if (!session.url) {
      throw new Error("Stripe 결제 페이지 URL을 생성하지 못했습니다.");
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("결제 세션 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "결제 페이지 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

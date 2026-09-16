import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { grantPurchasedCredits } from "@/lib/credits";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe가 결제 상태 변화를 알려주는 콜백. 사용자의 브라우저를 거치지 않고
// Stripe 서버가 직접 호출하므로, 여기서만 실제로 크레딧을 지급해야 안전하다
// (success_url로 돌아온 것만 믿으면, 사용자가 URL을 직접 조작해 결제 없이
// 크레딧을 받아갈 수 있음).
export async function POST(request: NextRequest) {
  if (!stripeSecretKey || !webhookSecret) {
    console.error("Stripe 웹훅 환경변수가 누락되었습니다.");
    return NextResponse.json({ error: "서버 설정 오류" }, { status: 500 });
  }

  const stripe = new Stripe(stripeSecretKey);
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    if (!signature) {
      throw new Error("stripe-signature 헤더가 없습니다.");
    }
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe 웹훅 서명 검증 실패:", err);
    return NextResponse.json({ error: "서명 검증 실패" }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits ?? 0);

      if (userId && credits > 0) {
        await grantPurchasedCredits(userId, credits, event.id);
      } else {
        console.error("웹훅에 userId/credits 메타데이터가 없습니다.", session.id);
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("크레딧 지급 처리 오류:", err);
    // 5xx로 응답해야 Stripe가 나중에 재시도해준다.
    return NextResponse.json({ error: "크레딧 지급 실패" }, { status: 500 });
  }
}

import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 정책 확정값 (비즈니스 모델 문서 기준) — 바뀌면 이 두 값만 수정하면 된다.
export const DAILY_FREE_LIMIT = 3;

type QuotaStatus = {
  freeUsedToday: number;
  freeRemaining: number;
  balance: number;
};

const getKstDateString = (): string => {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9(한국시간) 보정
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
};

// 현재 사용 가능한 무료 수량과 지갑 잔액을 조회한다 (읽기 전용, 차감하지 않음).
export const getQuotaStatus = async (userId: string): Promise<QuotaStatus> => {
  const today = getKstDateString();

  const [{ data: usageRow }, { data: walletRow }] = await Promise.all([
    supabaseAdmin
      .from("daily_free_usage")
      .select("free_count")
      .eq("user_id", userId)
      .eq("usage_date", today)
      .maybeSingle(),
    supabaseAdmin
      .from("credit_wallets")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const freeUsedToday = usageRow?.free_count ?? 0;

  return {
    freeUsedToday,
    freeRemaining: Math.max(0, DAILY_FREE_LIMIT - freeUsedToday),
    balance: walletRow?.balance ?? 0,
  };
};

// 이미지 생성 "성공 직후" 호출한다. 오늘 무료가 남아있으면 무료 사용량을 늘리고,
// 없으면 지갑 잔액을 1 차감한다. 실패 시(둘 다 소진) 예외를 던진다 — 이 경우
// 호출 전에 getQuotaStatus로 미리 확인했다면 정상적으로는 발생하지 않아야 한다.
export const consumeOneCredit = async (
  userId: string,
): Promise<QuotaStatus> => {
  const today = getKstDateString();
  const status = await getQuotaStatus(userId);

  if (status.freeRemaining > 0) {
    const { error } = await supabaseAdmin.from("daily_free_usage").upsert(
      {
        user_id: userId,
        usage_date: today,
        free_count: status.freeUsedToday + 1,
      },
      { onConflict: "user_id,usage_date" },
    );
    if (error) throw error;

    await supabaseAdmin.from("credit_transactions").insert({
      user_id: userId,
      amount: 0,
      type: "daily_free",
    });

    return {
      freeUsedToday: status.freeUsedToday + 1,
      freeRemaining: status.freeRemaining - 1,
      balance: status.balance,
    };
  }

  if (status.balance > 0) {
    const { error } = await supabaseAdmin
      .from("credit_wallets")
      .update({ balance: status.balance - 1 })
      .eq("user_id", userId);
    if (error) throw error;

    await supabaseAdmin.from("credit_transactions").insert({
      user_id: userId,
      amount: -1,
      type: "generation",
    });

    return { ...status, balance: status.balance - 1 };
  }

  throw new Error("크레딧이 부족합니다.");
};

// 결제 완료(Stripe 웹훅)로 크레딧을 지급한다. 같은 결제 건이 웹훅 재전송 등으로
// 중복 호출되어도 두 번 지급되지 않도록, 호출하는 쪽(webhook)에서 stripeEventId를
// credit_transactions에 함께 기록해 이미 처리된 이벤트인지 먼저 확인해야 한다.
export const grantPurchasedCredits = async (
  userId: string,
  amount: number,
  stripeEventId: string,
): Promise<void> => {
  const { data: existing } = await supabaseAdmin
    .from("credit_transactions")
    .select("id")
    .eq("type", "purchase")
    .eq("stripe_event_id", stripeEventId)
    .maybeSingle();

  if (existing) {
    // 이미 이 결제 이벤트로 크레딧을 지급한 적이 있음 — 중복 지급 방지.
    return;
  }

  const { data: walletRow } = await supabaseAdmin
    .from("credit_wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();

  const currentBalance = walletRow?.balance ?? 0;

  const { error: upsertError } = await supabaseAdmin
    .from("credit_wallets")
    .upsert(
      { user_id: userId, balance: currentBalance + amount },
      { onConflict: "user_id" },
    );
  if (upsertError) throw upsertError;

  const { error: txError } = await supabaseAdmin
    .from("credit_transactions")
    .insert({
      user_id: userId,
      amount,
      type: "purchase",
      stripe_event_id: stripeEventId,
    });
  if (txError) throw txError;
};

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

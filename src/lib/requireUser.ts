import { NextRequest } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// 요청 헤더의 Authorization: Bearer 토큰을 검증해 로그인한(=초대받은) 사용자를
// 반환한다. 여러 API 라우트에서 공통으로 쓰는 로그인 확인 로직.
export const requireUser = async (
  request: NextRequest,
): Promise<{ user: User } | { error: string; status: number }> => {
  if (!supabaseUrl || !supabasePublishableKey) {
    return { error: "서버 설정 오류: Supabase 환경변수가 누락되었습니다.", status: 500 };
  }

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace("Bearer ", "");

  if (!accessToken) {
    return { error: "로그인이 필요합니다.", status: 401 };
  }

  const supabase = createClient(supabaseUrl, supabasePublishableKey);
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (error || !data.user) {
    return { error: "로그인이 필요합니다.", status: 401 };
  }

  return { user: data.user };
};

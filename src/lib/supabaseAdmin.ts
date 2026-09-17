import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ⚠️ 서버(API 라우트) 전용. 절대 클라이언트 컴포넌트에서 import하지 말 것.
// service_role 키는 행 단위 보안(RLS)을 모두 우회하므로, 이미 로그인 검증을 마친
// 신뢰된 서버 코드에서만 사용해야 한다.
//
// 클라이언트를 "처음 실제로 쓸 때"에만 만든다(지연 초기화). 모듈을 import하는
// 시점(빌드 시 페이지 데이터 수집 단계 포함)에 곧바로 에러를 던지면 로컬처럼
// 이 환경변수가 없는 곳에서 빌드 자체가 깨질 수 있기 때문이다.
let cachedClient: SupabaseClient | null = null;

export const getSupabaseAdmin = (): SupabaseClient => {
  if (cachedClient) {
    return cachedClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Supabase 관리자 환경변수가 설정되지 않았습니다. .env.local의 " +
        "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 값을 확인해주세요.",
    );
  }

  cachedClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cachedClient;
};

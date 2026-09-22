// 다운로드 프록시가 받아줄 주소의 허용 목록.
//
// 이 판단을 라우트에서 분리한 이유: 우리 서버가 아무 주소나 대신 받아주는
// 통로(오픈 프록시)가 되면 내부망 주소를 넣어 훔쳐보는 공격(SSRF)이 가능해진다.
// 규칙을 한 곳에 모아두면 검증하기도, 나중에 바꾸기도 쉽다.

const REPLICATE_HOST = "replicate.delivery";

// 우리가 실제로 이미지를 두는 곳만 허용한다.
// - Replicate CDN: 생성 직후의 임시 이미지
// - Supabase Storage: 갤러리에 영구 보관한 이미지
export const isAllowedImageHost = (
  hostname: string,
  supabaseUrl: string | undefined,
): boolean => {
  if (hostname === REPLICATE_HOST || hostname.endsWith(`.${REPLICATE_HOST}`)) {
    return true;
  }

  if (supabaseUrl) {
    try {
      if (hostname === new URL(supabaseUrl).hostname) {
        return true;
      }
    } catch {
      // 환경변수가 URL 형식이 아니면 허용하지 않는다.
    }
  }

  return false;
};

// https가 아닌 주소, 허용 목록 밖의 주소를 모두 막는다.
export const parseAllowedImageUrl = (
  rawUrl: string,
  supabaseUrl: string | undefined,
): URL | null => {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }

  if (target.protocol !== "https:") {
    return null;
  }

  return isAllowedImageHost(target.hostname, supabaseUrl) ? target : null;
};

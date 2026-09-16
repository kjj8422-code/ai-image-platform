// 확정된 크레딧 판매 정책 (사업 모델 문서 기준). 가격을 바꾸려면 이 값만 수정하면 된다.
export const CREDIT_PACK = {
  credits: 100,
  priceKrw: 15000, // Stripe에서 KRW는 "0-decimal" 통화라 그대로 15000으로 넘기면 됨
  productName: "AI 이미지 크레딧 100장",
} as const;

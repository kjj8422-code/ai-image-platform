import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas는 네이티브 바이너리(.node)를 포함한 패키지라 번들러가 건드리지
  // 않고 그대로 require 하도록 서버 전용 외부 패키지로 지정한다.
  serverExternalPackages: ["@napi-rs/canvas"],
  // public/ 밑의 폰트 파일은 정적 자산이라 서버리스 함수 번들에는 기본적으로
  // 포함되지 않는다. 코드가 process.cwd() 기준 동적 경로로 읽기 때문에 빌드
  // 추적기(file tracing)가 자동으로 감지하지 못해, 명시적으로 포함시켜야 한다
  // (안 하면 폰트를 못 찾아 한글이 네모(tofu)로 깨진다 — 실제로 겪은 문제).
  outputFileTracingIncludes: {
    "/api/thumbnail/compose": ["./public/fonts/**"],
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @napi-rs/canvas는 네이티브 바이너리(.node)를 포함한 패키지라 번들러가 건드리지
  // 않고 그대로 require 하도록 서버 전용 외부 패키지로 지정한다.
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default nextConfig;

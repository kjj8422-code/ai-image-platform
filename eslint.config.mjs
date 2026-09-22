import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // marketing/kmong은 Next.js 앱과 무관한 독립 Node 스크립트(크몽 판매 이미지
    // 렌더링용)라 앱 코드와 같은 린트 규칙(예: no-require-imports)을 적용하지 않는다.
    "marketing/**",
  ]),
]);

export default eslintConfig;

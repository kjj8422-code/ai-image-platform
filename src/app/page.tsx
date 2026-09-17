import Link from "next/link";
import { AuthStatus } from "@/components/AuthStatus";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-50 px-4 dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-white">
        AI 이미지 생성 도구
      </h1>
      <AuthStatus />
      <Link
        href="/generate"
        className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        이미지 생성하러 가기
      </Link>
    </div>
  );
}

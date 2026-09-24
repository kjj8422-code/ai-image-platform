import Link from "next/link";
import { AuthStatus } from "@/components/AuthStatus";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-4 dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-white">
        AI 이미지 생성 도구
      </h1>
      <AuthStatus />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/generate"
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          이미지 생성하러 가기
        </Link>
        <Link
          href="/thumbnail"
          className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          쇼츠 썸네일 만들기
        </Link>
        <Link
          href="/shorts"
          className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          이미지로 쇼츠 만들기
        </Link>
        <Link
          href="/shorts/video"
          className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          AI 영상 쇼츠 만들기
        </Link>
        <Link
          href="/gallery"
          className="rounded-full border border-zinc-300 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          내 갤러리
        </Link>
      </div>
    </div>
  );
}

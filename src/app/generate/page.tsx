"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

export default function GeneratePage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const [prompt, setPrompt] = useState<string>("");
  const [imageUrl, setImageUrl] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage("");
    setIsGenerating(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error("로그인이 필요합니다.");
      }

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ prompt }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error ?? "이미지 생성에 실패했습니다.");
      }

      setImageUrl(result.imageUrl);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  if (userLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-500">로그인 상태 확인 중...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 px-4 dark:bg-black">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          이미지 생성은 로그인 후 이용하실 수 있습니다.
        </p>
        <Link
          href="/login"
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          로그인 / 회원가입
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-white">
        AI 이미지 생성
      </h1>

      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="flex w-full max-w-xl flex-col gap-3"
      >
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          required
          rows={3}
          placeholder="예: 노을 지는 바다 위를 나는 갈매기, 수채화 스타일"
          className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
        />
        <button
          type="submit"
          disabled={isGenerating}
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {isGenerating ? "생성 중... (최대 1분 정도 걸릴 수 있어요)" : "이미지 생성하기"}
        </button>
      </form>

      {errorMessage && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      )}

      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지라 next/image 설정 전까지 img 태그 사용
        <img
          src={imageUrl}
          alt={prompt}
          className="w-full max-w-xl rounded-xl border border-zinc-200 dark:border-zinc-800"
        />
      )}
    </div>
  );
}

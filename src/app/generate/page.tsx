"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function GeneratePage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const [prompt, setPrompt] = useState<string>("");
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [enhancedPrompt, setEnhancedPrompt] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage("");
    setIsGenerating(true);
    setSaveStates({});

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

      setImageUrls(Array.isArray(result.imageUrls) ? result.imageUrls : []);
      setEnhancedPrompt(
        typeof result.enhancedPrompt === "string" ? result.enhancedPrompt : "",
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async (imageUrl: string) => {
    setSaveStates((prev) => ({ ...prev, [imageUrl]: "saving" }));

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error("로그인이 필요합니다.");
      }

      const response = await fetch("/api/gallery/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ imageUrl, prompt: enhancedPrompt, source: "generated" }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result?.error ?? "저장에 실패했습니다.");
      }

      setSaveStates((prev) => ({ ...prev, [imageUrl]: "saved" }));
    } catch (err) {
      console.error(err);
      setSaveStates((prev) => ({ ...prev, [imageUrl]: "error" }));
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
          로그인
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">
          AI 이미지 생성
        </h1>
        <Link
          href="/gallery"
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          내 갤러리 →
        </Link>
      </div>

      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="flex w-full max-w-2xl flex-col gap-3"
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
          {isGenerating
            ? "4장 생성 중... (최대 1분 정도 걸릴 수 있어요)"
            : "이미지 4장 생성하기"}
        </button>
      </form>

      {errorMessage && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      )}

      {imageUrls.length > 0 && (
        <div className="flex w-full max-w-2xl flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            {imageUrls.map((imageUrl) => {
              const saveState = saveStates[imageUrl] ?? "idle";
              return (
                <div key={imageUrl} className="flex flex-col gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지라 next/image 설정 전까지 img 태그 사용 */}
                  <img
                    src={imageUrl}
                    alt={prompt}
                    className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSave(imageUrl)}
                      disabled={saveState === "saving" || saveState === "saved"}
                      className="flex-1 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      {saveState === "saving"
                        ? "저장 중..."
                        : saveState === "saved"
                          ? "✓ 저장됨"
                          : saveState === "error"
                            ? "저장 실패, 다시 시도"
                            : "갤러리에 저장"}
                    </button>
                    <a
                      href={imageUrl}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      다운로드
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
          {enhancedPrompt && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              AI가 보강한 프롬프트: {enhancedPrompt}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

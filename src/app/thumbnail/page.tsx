"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import {
  loadImage,
  ensureFontReady,
  renderThumbnail,
  renderSafeZoneOverlay,
} from "@/lib/thumbnailCanvas";

type SuggestState = "idle" | "loading" | "error";
type BackgroundState = "idle" | "loading" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";

export default function ThumbnailPage() {
  const { user, loading: userLoading } = useSupabaseUser();

  const [script, setScript] = useState("");
  const [suggestState, setSuggestState] = useState<SuggestState>("idle");
  const [suggestError, setSuggestError] = useState("");

  const [titleText, setTitleText] = useState("");
  const [backgroundPrompt, setBackgroundPrompt] = useState("");

  const [backgroundState, setBackgroundState] =
    useState<BackgroundState>("idle");
  const [backgroundError, setBackgroundError] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedBackground, setSelectedBackground] = useState<string>("");

  const [showSafeZone, setShowSafeZone] = useState(true);
  const [renderError, setRenderError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const authedFetch = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      throw new Error("로그인이 필요합니다.");
    }
    return fetch(input, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${session.access_token}`,
      },
    });
  };

  const handleSuggest = async () => {
    setSuggestError("");
    setSuggestState("loading");
    try {
      const response = await authedFetch("/api/thumbnail/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error ?? "문구 추천에 실패했습니다.");
      }
      setTitleText(typeof result.title === "string" ? result.title : "");
      setBackgroundPrompt(
        typeof result.backgroundPrompt === "string"
          ? result.backgroundPrompt
          : "",
      );
      setSuggestState("idle");
    } catch (err) {
      setSuggestError(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
      setSuggestState("error");
    }
  };

  const handleGenerateBackgrounds = async () => {
    setBackgroundError("");
    setBackgroundState("loading");
    setCandidates([]);
    setSelectedBackground("");
    try {
      const response = await authedFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: backgroundPrompt, aspectRatio: "9:16" }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error ?? "배경 생성에 실패했습니다.");
      }
      const urls: string[] = Array.isArray(result.imageUrls)
        ? result.imageUrls
        : [];
      setCandidates(urls);
      if (urls[0]) {
        setSelectedBackground(urls[0]);
      }
      setBackgroundState("idle");
    } catch (err) {
      setBackgroundError(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
      setBackgroundState("error");
    }
  };

  // 배경 선택 또는 타이틀 문구가 바뀔 때마다 캔버스를 다시 그린다.
  useEffect(() => {
    if (!selectedBackground || !titleText.trim()) {
      return;
    }

    let cancelled = false;
    setRenderError("");

    const run = async () => {
      try {
        await ensureFontReady(900);
        const image = await loadImage(selectedBackground);
        if (cancelled) {
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        renderThumbnail(canvas, { backgroundImage: image, titleText });
      } catch (err) {
        if (!cancelled) {
          setRenderError(
            err instanceof Error
              ? err.message
              : "미리보기를 그리지 못했습니다.",
          );
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedBackground, titleText]);

  // 세이프존 가이드 표시/숨김
  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) {
      return;
    }

    if (showSafeZone) {
      renderSafeZoneOverlay(overlay);
    } else {
      const ctx = overlay.getContext("2d");
      ctx?.clearRect(0, 0, overlay.width, overlay.height);
    }
  }, [showSafeZone, selectedBackground]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const link = document.createElement("a");
    link.download = "shorts-thumbnail.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const handleSaveToGallery = async () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    setSaveState("saving");
    try {
      const response = await authedFetch("/api/gallery/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: canvas.toDataURL("image/png"),
          prompt: titleText,
          source: "thumbnail",
        }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result?.error ?? "저장에 실패했습니다.");
      }
      setSaveState("saved");
    } catch (err) {
      console.error(err);
      setSaveState("error");
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
          쇼츠 썸네일 생성은 로그인 후 이용하실 수 있습니다.
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
          쇼츠/릴스 썸네일 생성
        </h1>
        <Link
          href="/generate"
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          ← 일반 이미지 생성
        </Link>
      </div>

      {/* 1단계: 문구/프롬프트 추천 */}
      <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          1. 대본 한 줄 또는 키워드를 입력하면 AI가 문구와 배경 프롬프트를 추천해줘요
        </p>
        <textarea
          value={script}
          onChange={(event) => setScript(event.target.value)}
          rows={2}
          placeholder="예: 퇴근 후 30분 홈트레이닝으로 뱃살 빼는 법"
          className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
        />
        <button
          type="button"
          onClick={() => void handleSuggest()}
          disabled={suggestState === "loading" || !script.trim()}
          className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {suggestState === "loading" ? "추천 중..." : "문구·프롬프트 추천받기"}
        </button>
        {suggestError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {suggestError}
          </p>
        )}

        {(titleText || backgroundPrompt) && (
          <div className="flex flex-col gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              메인 타이틀 문구 (직접 수정 가능)
              <input
                value={titleText}
                onChange={(event) => setTitleText(event.target.value)}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              배경 이미지 프롬프트 (영문, 직접 수정 가능)
              <textarea
                value={backgroundPrompt}
                onChange={(event) => setBackgroundPrompt(event.target.value)}
                rows={2}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
              />
            </label>
          </div>
        )}
      </section>

      {/* 2단계: 배경 생성 */}
      <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          2. 9:16 배경 이미지 4장을 생성해서 마음에 드는 걸 골라주세요
        </p>
        <button
          type="button"
          onClick={() => void handleGenerateBackgrounds()}
          disabled={backgroundState === "loading" || !backgroundPrompt.trim()}
          className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {backgroundState === "loading"
            ? "배경 4장 생성 중... (최대 1분)"
            : "9:16 배경 이미지 4장 생성하기"}
        </button>
        {backgroundError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {backgroundError}
          </p>
        )}

        {candidates.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {candidates.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => setSelectedBackground(url)}
                className={`overflow-hidden rounded-xl border-2 transition-colors ${
                  selectedBackground === url
                    ? "border-black dark:border-white"
                    : "border-transparent"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지 */}
                <img
                  src={url}
                  alt="배경 후보"
                  className="aspect-[9/16] w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 3단계: 미리보기 + 저장 */}
      {selectedBackground && (
        <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              3. 최종 썸네일 미리보기
            </p>
            <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={showSafeZone}
                onChange={(event) => setShowSafeZone(event.target.checked)}
              />
              세이프존 가이드 보기
            </label>
          </div>

          <div className="relative mx-auto w-full max-w-[320px]">
            <canvas
              ref={canvasRef}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
            />
            <canvas
              ref={overlayCanvasRef}
              className="pointer-events-none absolute inset-0 w-full"
            />
          </div>

          {renderError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {renderError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              다운로드
            </button>
            <button
              type="button"
              onClick={() => void handleSaveToGallery()}
              disabled={saveState === "saving" || saveState === "saved"}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {saveState === "saving"
                ? "저장 중..."
                : saveState === "saved"
                  ? "✓ 갤러리에 저장됨"
                  : saveState === "error"
                    ? "저장 실패, 다시 시도"
                    : "갤러리에 저장"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

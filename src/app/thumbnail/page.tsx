"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { readJson } from "@/lib/readJson";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

type SuggestState = "idle" | "loading" | "error";
type BackgroundState = "idle" | "loading" | "error";
type ComposeState = "idle" | "loading" | "error";
type SaveState = "idle" | "saving" | "saved" | "error";

// 타이핑 중 매 글자마다 서버에 합성 요청을 보내지 않도록 살짝 지연시킨다.
const COMPOSE_DEBOUNCE_MS = 500;
// 반복 생성이 잦은 화면이라 비용·대기시간을 줄이려고 4장 대신 2장만 생성한다.
const BACKGROUND_CANDIDATE_COUNT = 2;

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });

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
  const [composeState, setComposeState] = useState<ComposeState>("idle");
  const [composeError, setComposeError] = useState("");
  const [composedUrl, setComposedUrl] = useState("");
  const composedBlobRef = useRef<Blob | null>(null);
  const composedUrlRef = useRef<string>("");

  const [saveState, setSaveState] = useState<SaveState>("idle");

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
      const result = await readJson(response);
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
        body: JSON.stringify({
          prompt: backgroundPrompt,
          format: "story",
          count: BACKGROUND_CANDIDATE_COUNT,
          // 이미 문구 추천 단계에서 구도·인물 지시까지 담아 만든 영문 프롬프트라
          // 서버에서 다시 보강하지 않는다(한글을 직접 써 넣은 경우는 서버가 알아서 번역).
          enhance: false,
        }),
      });
      const result = await readJson(response);
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

  // 배경 선택 또는 타이틀 문구가 바뀔 때마다(살짝 지연 후) 서버에 최종 합성을
  // 요청한다. 문구·외곽선·그림자·그라데이션은 모두 서버(@napi-rs/canvas)가
  // 그려서 돌려주므로, 여기서는 결과 이미지를 받아 보여주기만 한다.
  useEffect(() => {
    if (!selectedBackground || !titleText.trim()) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const run = async () => {
        setComposeError("");
        setComposeState("loading");
        try {
          const response = await authedFetch("/api/thumbnail/compose", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              backgroundUrl: selectedBackground,
              title: titleText,
            }),
          });

          if (!response.ok) {
            const result = await readJson(response);
            throw new Error(result?.error ?? "합성에 실패했습니다.");
          }

          const blob = await response.blob();
          if (cancelled) {
            return;
          }
          composedBlobRef.current = blob;
          const nextUrl = URL.createObjectURL(blob);
          if (composedUrlRef.current) {
            URL.revokeObjectURL(composedUrlRef.current);
          }
          composedUrlRef.current = nextUrl;
          setComposedUrl(nextUrl);
          // 문구나 배경이 바뀌어 새 이미지가 나왔으면 "저장됨"은 옛 이미지 얘기다.
          // 그대로 두면 버튼이 잠겨서 새 버전을 저장할 수 없었다.
          setSaveState("idle");
          setComposeState("idle");
        } catch (err) {
          if (!cancelled) {
            setComposeError(
              err instanceof Error ? err.message : "합성에 실패했습니다.",
            );
            setComposeState("error");
          }
        }
      };

      void run();
    }, COMPOSE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedBackground, titleText]);

  // 화면을 떠날 때 마지막으로 만든 objectURL을 정리한다. 상태값(composedUrl)을
  // 직접 쓰면 처음 값("")에 묶여서 정작 마지막 이미지는 정리되지 않는다.
  useEffect(() => {
    return () => {
      if (composedUrlRef.current) {
        URL.revokeObjectURL(composedUrlRef.current);
      }
    };
  }, []);

  const handleDownload = () => {
    if (!composedUrl) {
      return;
    }
    const link = document.createElement("a");
    link.download = "shorts-thumbnail.png";
    link.href = composedUrl;
    link.click();
  };

  const handleSaveToGallery = async () => {
    if (!composedBlobRef.current) {
      return;
    }

    setSaveState("saving");
    try {
      const imageDataUrl = await blobToDataUrl(composedBlobRef.current);
      const response = await authedFetch("/api/gallery/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl,
          prompt: titleText,
          source: "thumbnail",
        }),
      });

      if (!response.ok) {
        const result = await readJson(response);
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
      <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-500">로그인 상태 확인 중...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-4 dark:bg-black">
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
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
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
          1. 대본 한 줄 또는 키워드를 입력하면 AI가 (B급 감성으로) 문구와 배경
          프롬프트를 추천해줘요
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
          2. 9:16 배경 이미지 {BACKGROUND_CANDIDATE_COUNT}장을 생성해서 마음에 드는 걸
          골라주세요
        </p>
        <button
          type="button"
          onClick={() => void handleGenerateBackgrounds()}
          disabled={backgroundState === "loading" || !backgroundPrompt.trim()}
          className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {backgroundState === "loading"
            ? `배경 ${BACKGROUND_CANDIDATE_COUNT}장 생성 중... (최대 1분)`
            : `9:16 배경 이미지 ${BACKGROUND_CANDIDATE_COUNT}장 생성하기`}
        </button>
        {backgroundError && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {backgroundError}
          </p>
        )}

        {candidates.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
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
              3. 최종 썸네일 미리보기{" "}
              {composeState === "loading" && (
                <span className="text-xs font-normal text-zinc-400">
                  (합성 중...)
                </span>
              )}
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

          <div className="relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
            {composedUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- blob object URL
              <img
                src={composedUrl}
                alt="썸네일 미리보기"
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}

            {showSafeZone && (
              <>
                {/* 하단 25%: 제목/채널정보 영역 */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 border-t-2 border-dashed border-red-500 bg-red-500/25" />
                {/* 우측 15%: 좋아요/댓글/공유 버튼 영역 */}
                <div className="pointer-events-none absolute inset-y-0 right-0 w-[15%] border-l-2 border-dashed border-red-500 bg-red-500/25" />
              </>
            )}
          </div>

          {composeError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {composeError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleDownload}
              disabled={!composedUrl}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              다운로드
            </button>
            <button
              type="button"
              onClick={() => void handleSaveToGallery()}
              disabled={
                !composedUrl || saveState === "saving" || saveState === "saved"
              }
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

"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import { downloadImage } from "@/lib/downloadImage";
import { readJson } from "@/lib/readJson";
import {
  DEFAULT_FORMAT_ID,
  IMAGE_FORMATS,
  type ImageFormatId,
} from "@/lib/imageFormats";

type SaveState = "idle" | "saving" | "saved" | "error";
type DownloadState = "idle" | "downloading" | "error";
type BgRemoveState = "idle" | "processing" | "error";

// 4장을 서버 요청 한 번에 몰아서 만들면, Replicate가 느리거나 속도 제한으로 기다릴 때
// 서버 제한 시간(60초)을 넘겨 요청이 통째로 끊긴다. 이미 만든 장은 돈이 나갔는데
// 화면엔 하나도 안 온다. 그래서 1장씩 따로 요청하고, 오는 대로 바로 보여준다.
const IMAGES_PER_RUN = 4;

export default function GeneratePage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const [prompt, setPrompt] = useState<string>("");
  const [formatId, setFormatId] = useState<ImageFormatId>(DEFAULT_FORMAT_ID);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [enhancedPrompt, setEnhancedPrompt] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generatingIndex, setGeneratingIndex] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [bgRemoveStates, setBgRemoveStates] = useState<
    Record<string, BgRemoveState>
  >({});
  const [bgRemovedUrls, setBgRemovedUrls] = useState<Record<string, string>>(
    {},
  );
  const [downloadStates, setDownloadStates] = useState<
    Record<string, DownloadState>
  >({});

  // 이미지를 사용자의 기기에 저장한다. 실패하면 버튼에 바로 표시해
  // 왜 안 됐는지 알 수 있게 한다.
  const handleDownload = async (imageUrl: string) => {
    setDownloadStates((prev) => ({ ...prev, [imageUrl]: "downloading" }));
    try {
      await downloadImage(imageUrl);
      setDownloadStates((prev) => ({ ...prev, [imageUrl]: "idle" }));
    } catch (err) {
      console.error("이미지 저장 오류:", err);
      setDownloadStates((prev) => ({ ...prev, [imageUrl]: "error" }));
      setErrorMessage(
        err instanceof Error ? err.message : "이미지 저장에 실패했습니다.",
      );
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage("");
    setIsGenerating(true);
    setImageUrls([]);
    setEnhancedPrompt("");
    setSaveStates({});
    setBgRemoveStates({});
    setBgRemovedUrls({});

    // 첫 장에서 AI가 번역·보강한 영어 프롬프트를 나머지 장에 그대로 쓴다.
    // 네 번 따로 보강하면 장마다 다른 그림이 되고 호출 비용도 네 번 든다.
    let promptForRest = "";
    let made = 0;

    try {
      for (let i = 0; i < IMAGES_PER_RUN; i += 1) {
        setGeneratingIndex(i + 1);
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
          body: JSON.stringify(
            i === 0
              ? { prompt, format: formatId, count: 1 }
              : { prompt: promptForRest, format: formatId, count: 1, enhance: false },
          ),
        });

        const result = await readJson(response);

        if (!response.ok) {
          throw new Error(result?.error ?? "이미지 생성에 실패했습니다.");
        }

        const urls: string[] = Array.isArray(result.imageUrls) ? result.imageUrls : [];
        made += urls.length;
        setImageUrls((prev) => [...prev, ...urls]);

        if (i === 0) {
          promptForRest =
            typeof result.enhancedPrompt === "string" && result.enhancedPrompt
              ? result.enhancedPrompt
              : prompt;
          setEnhancedPrompt(promptForRest);
        }
      }
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      setErrorMessage(
        made > 0 ? `${made}장까지 만들고 멈췄어요. 만든 이미지는 아래에 있어요. (${reason})` : reason,
      );
    } finally {
      setIsGenerating(false);
      setGeneratingIndex(0);
    }
  };

  const handleSave = async (imageUrl: string, source: "generated" | "remix" = "generated") => {
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
        body: JSON.stringify({ imageUrl, prompt: enhancedPrompt, source }),
      });

      if (!response.ok) {
        const result = await readJson(response);
        throw new Error(result?.error ?? "저장에 실패했습니다.");
      }

      setSaveStates((prev) => ({ ...prev, [imageUrl]: "saved" }));
    } catch (err) {
      console.error(err);
      setSaveStates((prev) => ({ ...prev, [imageUrl]: "error" }));
    }
  };

  const handleRemoveBackground = async (imageUrl: string) => {
    setBgRemoveStates((prev) => ({ ...prev, [imageUrl]: "processing" }));

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error("로그인이 필요합니다.");
      }

      const response = await fetch("/api/remove-background", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ imageUrl }),
      });

      const result = await readJson(response);

      if (!response.ok) {
        throw new Error(result?.error ?? "배경 제거에 실패했습니다.");
      }

      setBgRemovedUrls((prev) => ({ ...prev, [imageUrl]: result.imageUrl }));
      setBgRemoveStates((prev) => ({ ...prev, [imageUrl]: "idle" }));
    } catch (err) {
      console.error(err);
      setBgRemoveStates((prev) => ({ ...prev, [imageUrl]: "error" }));
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
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
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
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            어디에 쓸 이미지인가요? (규격에 맞는 비율로 생성됩니다)
          </span>
          <div className="flex flex-wrap gap-2">
            {IMAGE_FORMATS.map((format) => {
              const isSelected = format.id === formatId;
              return (
                <button
                  key={format.id}
                  type="button"
                  onClick={() => setFormatId(format.id)}
                  aria-pressed={isSelected}
                  className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left transition-colors ${
                    isSelected
                      ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                      : "border-zinc-300 text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500"
                  }`}
                >
                  <span className="text-xs font-semibold">{format.label}</span>
                  <span className="text-[10px] opacity-70">{format.hint}</span>
                </button>
              );
            })}
          </div>
        </div>

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
            ? `${generatingIndex}/${IMAGES_PER_RUN}장째 생성 중... (다 된 건 바로 아래에 보여요)`
            : `이미지 ${IMAGES_PER_RUN}장 생성하기`}
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
              const bgState = bgRemoveStates[imageUrl] ?? "idle";
              const bgRemovedUrl = bgRemovedUrls[imageUrl];

              return (
                <div key={imageUrl} className="flex flex-col gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지라 next/image 설정 전까지 img 태그 사용 */}
                  <img
                    src={imageUrl}
                    alt={prompt}
                    className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
                  />
                  <div className="flex flex-wrap items-center gap-2">
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
                    <button
                      type="button"
                      onClick={() => void handleDownload(imageUrl)}
                      disabled={downloadStates[imageUrl] === "downloading"}
                      className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      {downloadStates[imageUrl] === "downloading"
                        ? "저장 중..."
                        : downloadStates[imageUrl] === "error"
                          ? "저장 실패, 다시 시도"
                          : "이미지 저장"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemoveBackground(imageUrl)}
                      disabled={bgState === "processing"}
                      className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      {bgState === "processing"
                        ? "배경 제거 중..."
                        : bgState === "error"
                          ? "배경 제거 실패, 다시 시도"
                          : "누끼컷(배경 제거)"}
                    </button>
                  </div>

                  {bgRemovedUrl && (
                    <div
                      className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-2 dark:border-zinc-700"
                      style={{
                        backgroundImage:
                          "repeating-conic-gradient(#e5e5e5 0% 25%, transparent 0% 50%) 50% / 16px 16px",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지라 next/image 설정 전까지 img 태그 사용 */}
                      <img
                        src={bgRemovedUrl}
                        alt="배경 제거된 이미지"
                        className="w-full rounded-lg"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSave(bgRemovedUrl)}
                          disabled={
                            saveStates[bgRemovedUrl] === "saving" ||
                            saveStates[bgRemovedUrl] === "saved"
                          }
                          className="flex-1 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                        >
                          {saveStates[bgRemovedUrl] === "saving"
                            ? "저장 중..."
                            : saveStates[bgRemovedUrl] === "saved"
                              ? "✓ 저장됨"
                              : "갤러리에 저장"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDownload(bgRemovedUrl)}
                          disabled={downloadStates[bgRemovedUrl] === "downloading"}
                          className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                        >
                          {downloadStates[bgRemovedUrl] === "downloading"
                            ? "저장 중..."
                            : downloadStates[bgRemovedUrl] === "error"
                              ? "저장 실패, 다시 시도"
                              : "이미지 저장"}
                        </button>
                      </div>
                    </div>
                  )}
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

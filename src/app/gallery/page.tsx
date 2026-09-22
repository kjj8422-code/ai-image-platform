"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { downloadImage } from "@/lib/downloadImage";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import type { GalleryImage } from "@/lib/gallery";

const toErrorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

// 갤러리 목록을 불러오기만 한다. 화면 상태를 건드리지 않으므로
// effect 안에서 호출해도 렌더를 연쇄시키지 않는다.
const fetchGalleryImages = async (): Promise<GalleryImage[]> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("로그인이 필요합니다.");
  }

  const response = await fetch("/api/gallery/list", {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result?.error ?? "갤러리를 불러오지 못했습니다.");
  }

  return Array.isArray(result.images) ? result.images : [];
};

export default function GalleryPage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>("");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [remixPrompt, setRemixPrompt] = useState<string>("");
  const [isRemixing, setIsRemixing] = useState<boolean>(false);
  const [remixError, setRemixError] = useState<string>("");
  const [remixResult, setRemixResult] = useState<string>("");
  const [remixSaveState, setRemixSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [downloadState, setDownloadState] = useState<
    "idle" | "downloading" | "error"
  >("idle");

  // 이미지를 사용자의 기기에 저장한다. 실패하면 버튼과 메시지로 함께 알린다.
  const handleDownload = async (imageUrl: string) => {
    setDownloadState("downloading");
    try {
      await downloadImage(imageUrl);
      setDownloadState("idle");
    } catch (err) {
      console.error("이미지 저장 오류:", err);
      setDownloadState("error");
      setRemixError(toErrorMessage(err, "이미지 저장에 실패했습니다."));
    }
  };

  // 저장 직후처럼 목록을 "다시" 불러와야 할 때 쓴다. 버튼·이벤트에서만 호출한다.
  const reloadImages = async () => {
    setIsLoading(true);
    setLoadError("");

    try {
      setImages(await fetchGalleryImages());
    } catch (err) {
      setLoadError(toErrorMessage(err, "알 수 없는 오류가 발생했습니다."));
    } finally {
      setIsLoading(false);
    }
  };

  // 화면에 처음 들어올 때 목록을 채운다.
  //
  // effect 본문에서 곧바로 setState를 호출하면 렌더가 연쇄적으로 일어난다.
  // 그래서 여기서는 상태를 건드리지 않는 fetchGalleryImages를 먼저 await하고,
  // 결과가 온 뒤에만 상태를 바꾼다. isLoading은 초기값이 이미 true라
  // 다시 세팅할 필요도 없다.
  useEffect(() => {
    if (!user) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const loaded = await fetchGalleryImages();
        if (!cancelled) {
          setImages(loaded);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(toErrorMessage(err, "알 수 없는 오류가 발생했습니다."));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void run();

    // 화면을 떠났거나 로그인 사용자가 바뀌면 이전 요청 결과는 버린다.
    return () => {
      cancelled = true;
    };
  }, [user]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handleRemix = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRemixError("");
    setRemixResult("");
    setRemixSaveState("idle");
    setIsRemixing(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error("로그인이 필요합니다.");
      }

      const response = await fetch("/api/remix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ prompt: remixPrompt, imageIds: selectedIds }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error ?? "합성에 실패했습니다.");
      }

      setRemixResult(result.imageUrl);
    } catch (err) {
      setRemixError(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
    } finally {
      setIsRemixing(false);
    }
  };

  const handleSaveRemix = async () => {
    setRemixSaveState("saving");

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
        body: JSON.stringify({
          imageUrl: remixResult,
          prompt: remixPrompt,
          source: "remix",
        }),
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result?.error ?? "저장에 실패했습니다.");
      }

      setRemixSaveState("saved");
      await reloadImages();
    } catch (err) {
      console.error(err);
      setRemixSaveState("error");
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
          갤러리는 로그인 후 이용하실 수 있습니다.
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
          내 갤러리
        </h1>
        <Link
          href="/generate"
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          ← 이미지 생성하기
        </Link>
      </div>

      <p className="w-full max-w-2xl text-xs text-zinc-500 dark:text-zinc-400">
        이미지를 2장 이상 선택하면, 그 이미지들을 참고해서 새로운 이미지로 합성할 수
        있어요.
      </p>

      {isLoading && (
        <p className="text-sm text-zinc-500">불러오는 중...</p>
      )}
      {loadError && (
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      )}
      {!isLoading && !loadError && images.length === 0 && (
        <p className="text-sm text-zinc-500">
          아직 저장한 이미지가 없어요. 이미지 생성 화면에서 마음에 드는 이미지를
          저장해보세요.
        </p>
      )}

      {images.length > 0 && (
        <div className="grid w-full max-w-2xl grid-cols-3 gap-3">
          {images.map((image) => {
            const isSelected = selectedIds.includes(image.id);
            return (
              <div
                key={image.id}
                className={`relative overflow-hidden rounded-xl border-2 transition-colors ${
                  isSelected
                    ? "border-black dark:border-white"
                    : "border-transparent"
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleSelect(image.id)}
                  className="block w-full"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- 외부/스토리지 이미지, next/image 설정 전까지 img 태그 사용 */}
                  <img
                    src={image.imageUrl}
                    alt={image.prompt ?? "저장된 이미지"}
                    className="aspect-square w-full object-cover"
                  />
                </button>
                {isSelected && (
                  <span className="absolute right-1 top-1 rounded-full bg-black px-2 py-0.5 text-[10px] font-medium text-white dark:bg-white dark:text-black">
                    선택됨
                  </span>
                )}
                <Link
                  href={`/edit/${image.id}`}
                  className="absolute bottom-1 left-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-black"
                >
                  편집
                </Link>
                <button
                  type="button"
                  onClick={() => void handleDownload(image.imageUrl)}
                  disabled={downloadState === "downloading"}
                  className="absolute bottom-1 right-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-black disabled:opacity-50"
                >
                  저장
                </button>
              </div>
            );
          })}
        </div>
      )}

      <form
        onSubmit={(event) => void handleRemix(event)}
        className="flex w-full max-w-2xl flex-col gap-3 border-t border-zinc-200 pt-6 dark:border-zinc-800"
      >
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          선택한 {selectedIds.length}장으로 합성하기
        </p>
        <textarea
          value={remixPrompt}
          onChange={(event) => setRemixPrompt(event.target.value)}
          required
          rows={2}
          placeholder="예: 첫 번째 이미지의 인물에게 두 번째 이미지의 배경을 합성해줘"
          className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
        />
        <button
          type="submit"
          disabled={isRemixing || selectedIds.length < 2}
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {isRemixing
            ? "합성 중... (최대 1분 정도 걸릴 수 있어요)"
            : "선택한 이미지로 합성하기"}
        </button>
        {selectedIds.length < 2 && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            위 갤러리에서 이미지를 2장 이상 선택해주세요.
          </p>
        )}
      </form>

      {remixError && (
        <p className="text-sm text-red-600 dark:text-red-400">{remixError}</p>
      )}

      {remixResult && (
        <div className="flex w-full max-w-2xl flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지라 next/image 설정 전까지 img 태그 사용 */}
          <img
            src={remixResult}
            alt="합성 결과"
            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleSaveRemix()}
              disabled={remixSaveState === "saving" || remixSaveState === "saved"}
              className="flex-1 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {remixSaveState === "saving"
                ? "저장 중..."
                : remixSaveState === "saved"
                  ? "✓ 갤러리에 저장됨"
                  : remixSaveState === "error"
                    ? "저장 실패, 다시 시도"
                    : "갤러리에 저장"}
            </button>
            <button
              type="button"
              onClick={() => void handleDownload(remixResult)}
              disabled={downloadState === "downloading"}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {downloadState === "downloading"
                ? "저장 중..."
                : downloadState === "error"
                  ? "저장 실패, 다시 시도"
                  : "이미지 저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

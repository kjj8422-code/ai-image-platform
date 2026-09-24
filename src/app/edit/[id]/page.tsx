"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { readJson } from "@/lib/readJson";
import { downloadImage } from "@/lib/downloadImage";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import type { GalleryImage } from "@/lib/gallery";

// 붓 크기를 픽셀로 고정하면 큰 이미지(예: 1440px)에서는 붓이 바늘처럼 가늘어진다.
// 이미지 짧은 변의 비율로 정해서 어떤 크기의 이미지든 화면에서 비슷하게 보이게 한다.
const BRUSH_RATIO = 0.035;
const MIN_BRUSH_RADIUS = 12;

const brushRadiusFor = (canvas: HTMLCanvasElement): number =>
  Math.max(MIN_BRUSH_RADIUS, Math.round(Math.min(canvas.width, canvas.height) * BRUSH_RATIO));

export default function EditImagePage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const params = useParams<{ id: string }>();
  const imageId = params.id;

  const [sourceImage, setSourceImage] = useState<GalleryImage | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 칠한 자리를 보여주는 투명 막. 이미지 위에 겹쳐 두고 막 전체를 반투명하게 한다.
  // 반투명 빨강을 이미지에 직접 겹쳐 칠하면 선이 겹치는 곳마다 진한 얼룩이 생긴다.
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isPaintingRef = useRef<boolean>(false);
  // 직전에 칠한 점. 빠르게 문지르면 이벤트 사이가 벌어지는데, 점만 찍으면 선이
  // 끊긴 점선이 된다. 직전 점과 선으로 이어서 빈틈 없이 칠한다.
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasPainted, setHasPainted] = useState<boolean>(false);

  const [prompt, setPrompt] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [resultUrl, setResultUrl] = useState<string>("");
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
      setErrorMessage(
        err instanceof Error ? err.message : "이미지 저장에 실패했습니다.",
      );
    }
  };

  const [enhancedPrompt, setEnhancedPrompt] = useState<string>("");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  // 갤러리 목록에서 이 페이지가 보여줄 이미지를 찾아온다 (단건 조회 API가 따로
  // 없어서, 이미 있는 목록 API를 재사용).
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setLoadError("");

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          throw new Error("로그인이 필요합니다.");
        }

        const response = await fetch("/api/gallery/list", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const result = await readJson(response);

        if (!response.ok) {
          throw new Error(result?.error ?? "이미지를 불러오지 못했습니다.");
        }

        const images: GalleryImage[] = Array.isArray(result.images)
          ? result.images
          : [];
        const found = images.find((image) => image.id === imageId) ?? null;

        if (!found) {
          throw new Error("해당 이미지를 찾을 수 없습니다.");
        }

        setSourceImage(found);
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
        );
      } finally {
        setIsLoading(false);
      }
    };

    if (user && imageId) {
      void load();
    }
  }, [user, imageId]);

  // 이미지 로드가 끝나면, 화면에 보이는 캔버스에 이미지를 그리고, 화면에는
  // 안 보이는(=DOM에 붙지 않는) 마스크 캔버스를 같은 크기로 검은색으로 초기화한다.
  useEffect(() => {
    if (!sourceImage) {
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const displayCanvas = displayCanvasRef.current;
      if (!displayCanvas) {
        return;
      }

      displayCanvas.width = img.naturalWidth;
      displayCanvas.height = img.naturalHeight;
      const ctx = displayCanvas.getContext("2d");
      ctx?.drawImage(img, 0, 0);

      const overlayCanvas = overlayCanvasRef.current;
      if (overlayCanvas) {
        overlayCanvas.width = img.naturalWidth;
        overlayCanvas.height = img.naturalHeight;
      }

      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = img.naturalWidth;
      maskCanvas.height = img.naturalHeight;
      const maskCtx = maskCanvas.getContext("2d");
      if (maskCtx) {
        maskCtx.fillStyle = "black";
        maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      }
      maskCanvasRef.current = maskCanvas;
      setHasPainted(false);
    };
    img.src = sourceImage.imageUrl;
  }, [sourceImage]);

  const getCanvasPoint = (
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const paintAt = (clientX: number, clientY: number) => {
    const overlayCanvas = overlayCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!overlayCanvas || !maskCanvas) {
      return;
    }

    const point = getCanvasPoint(overlayCanvas, clientX, clientY);
    const from = lastPointRef.current ?? point;
    const radius = brushRadiusFor(overlayCanvas);

    const stroke = (ctx: CanvasRenderingContext2D, color: string) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = radius * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      // 제자리에서 톡 찍었을 때(길이 0인 선)도 동그랗게 칠해지도록.
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    // 화면용: 빨강으로 칠한다(막 자체가 반투명이라 이미지가 비쳐 보인다).
    const overlayCtx = overlayCanvas.getContext("2d");
    if (overlayCtx) {
      stroke(overlayCtx, "rgb(239, 68, 68)");
    }

    // 실제 마스크용: 순수 흰색 (이 부분이 AI가 새로 그릴 영역)
    const maskCtx = maskCanvas.getContext("2d");
    if (maskCtx) {
      stroke(maskCtx, "white");
    }

    lastPointRef.current = point;
    setHasPainted(true);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    isPaintingRef.current = true;
    lastPointRef.current = null;
    // 손가락·마우스가 캔버스 밖으로 살짝 나갔다 들어와도 칠하던 선이 이어지게 붙잡는다.
    event.currentTarget.setPointerCapture(event.pointerId);
    paintAt(event.clientX, event.clientY);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPaintingRef.current) {
      return;
    }
    paintAt(event.clientX, event.clientY);
  };

  const stopPainting = () => {
    isPaintingRef.current = false;
    lastPointRef.current = null;
  };

  const handleClearMask = () => {
    const overlayCanvas = overlayCanvasRef.current;
    overlayCanvas
      ?.getContext("2d")
      ?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext("2d");
    if (maskCanvas && maskCtx) {
      maskCtx.fillStyle = "black";
      maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
    setHasPainted(false);
  };

  const handleSubmit = async () => {
    if (!sourceImage || !maskCanvasRef.current) {
      return;
    }

    setErrorMessage("");
    setResultUrl("");
    setSaveState("idle");
    setIsSubmitting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        throw new Error("로그인이 필요합니다.");
      }

      const maskDataUrl = maskCanvasRef.current.toDataURL("image/png");

      const response = await fetch("/api/inpaint", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ imageId: sourceImage.id, maskDataUrl, prompt }),
      });

      const result = await readJson(response);

      if (!response.ok) {
        throw new Error(result?.error ?? "편집에 실패했습니다.");
      }

      setResultUrl(result.imageUrl);
      setEnhancedPrompt(
        typeof result.enhancedPrompt === "string" ? result.enhancedPrompt : "",
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveResult = async () => {
    setSaveState("saving");

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
          imageUrl: resultUrl,
          prompt: enhancedPrompt,
          source: "inpaint",
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
          편집은 로그인 후 이용하실 수 있습니다.
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
    <div className="flex flex-1 flex-col items-center gap-4 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">
          마스킹 편집
        </h1>
        <Link
          href="/gallery"
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          ← 갤러리로
        </Link>
      </div>

      <p className="w-full max-w-2xl text-xs text-zinc-500 dark:text-zinc-400">
        이미지에서 바꾸고 싶은 부분을 손가락(또는 마우스)으로 칠한 다음, 그 자리에
        무엇이 들어갈지 설명해주세요. 칠하지 않은 부분은 그대로 유지됩니다.
      </p>

      {isLoading && <p className="text-sm text-zinc-500">불러오는 중...</p>}
      {loadError && (
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
      )}

      {sourceImage && (
        <div className="flex w-full max-w-2xl flex-col gap-3">
          <div className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <canvas ref={displayCanvasRef} className="block w-full" />
            <canvas
              ref={overlayCanvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={stopPainting}
              onPointerCancel={stopPainting}
              className="absolute inset-0 h-full w-full cursor-crosshair touch-none opacity-50"
            />
          </div>

          <button
            type="button"
            onClick={handleClearMask}
            className="self-start rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            칠한 부분 지우기
          </button>

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            placeholder="예: 여기에 우주모자 대신 왕관을 그려줘"
            className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
          />

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !hasPainted || !prompt.trim()}
            className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {isSubmitting
              ? "편집 중... (최대 1분 정도 걸릴 수 있어요)"
              : "칠한 부분 새로 그리기"}
          </button>
          {!hasPainted && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              위 이미지에서 바꾸고 싶은 부분을 먼저 칠해주세요.
            </p>
          )}
        </div>
      )}

      {errorMessage && (
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      )}

      {resultUrl && (
        <div className="flex w-full max-w-2xl flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- 외부 도메인 이미지라 next/image 설정 전까지 img 태그 사용 */}
          <img
            src={resultUrl}
            alt="편집 결과"
            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleSaveResult()}
              disabled={saveState === "saving" || saveState === "saved"}
              className="flex-1 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {saveState === "saving"
                ? "저장 중..."
                : saveState === "saved"
                  ? "✓ 갤러리에 저장됨"
                  : saveState === "error"
                    ? "저장 실패, 다시 시도"
                    : "갤러리에 저장"}
            </button>
            <button
              type="button"
              onClick={() => void handleDownload(resultUrl)}
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

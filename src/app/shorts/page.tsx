"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

type Step = "idle" | "uploading" | "analyzing" | "composing" | "done" | "error";

type Scene = {
  index: number;
  narration: string;
  sfx: string;
  kenBurns: "in" | "out";
  imageUrl: string;
};

type Storyboard = {
  thumbnailCopy: string;
  bgmMood: string;
  scenes: Scene[];
};

const MIN_IMAGES = 5;
const MAX_IMAGES = 15;

const STEP_LABEL: Record<Step, string> = {
  idle: "",
  uploading: "이미지 업로드 중...",
  analyzing: "AI가 이미지를 보고 대본 쓰는 중... (30초 정도)",
  composing: "썸네일 만드는 중...",
  done: "완성!",
  error: "",
};

// 업로드 전에 브라우저에서 사진을 줄인다. 폰 사진 한 장은 3~5MB이고 base64로
// 바꾸면 거기서 1.33배가 더 붙어서, 원본 6장을 한 번에 보내면 Vercel의 요청 본문
// 상한(4.5MB)을 훌쩍 넘긴다. 그러면 서버는 JSON이 아닌 "Request Entity Too Large"
// 평문을 돌려주고, 화면에는 원인을 알 수 없는 JSON 파싱 오류만 남는다.
// 줄여 보내면 그 한계를 피하는 동시에 Claude가 읽는 픽셀 수도 줄어 비전 토큰
// 비용까지 같이 내려간다. 쇼츠는 세로 1080 기준이라 1280px이면 화질 손해가 없다.
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

type LoadedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

// 폰 사진은 회전 정보가 EXIF에만 들어 있어서, 그냥 그리면 눕거나 뒤집힌 채로 올라간다.
const loadImage = async (file: File): Promise<LoadedImage> => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // 이 옵션을 거부하는 브라우저가 있다. 아래 <img> 경로로 넘어간다.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new Error(`${file.name} 을(를) 읽지 못했습니다.`));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
};

const downscaleToDataUrl = async (file: File): Promise<string> => {
  const image = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error(`${file.name} 을(를) 변환하지 못했습니다.`);
    }
    ctx.drawImage(image.source, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    image.release();
  }
};

// 본문 초과(413)나 시간 초과(504)처럼 우리 코드에 닿기 전에 끊기는 경우, 플랫폼은
// JSON이 아닌 평문을 돌려준다. 그대로 .json()을 부르면 진짜 원인이 파싱 오류에
// 가려지므로, 먼저 본문을 읽고 사람이 읽을 수 있는 말로 바꿔준다.
const readJson = async <T,>(response: Response, fallback: string): Promise<T> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (response.status === 413) {
      throw new Error(
        "이미지 용량이 너무 큽니다. 장수를 줄이거나 더 작은 사진으로 다시 시도해주세요.",
      );
    }
    if (response.status === 504) {
      throw new Error(
        "서버가 제한 시간 안에 응답하지 못했습니다. 이미지 장수를 줄여 다시 시도해주세요.",
      );
    }
    throw new Error(`${fallback} (서버 응답 코드 ${response.status})`);
  }
};

export default function ShortsPage() {
  const { user, loading: userLoading } = useSupabaseUser();

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [step, setStep] = useState<Step>("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [projectUrl, setProjectUrl] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 미리보기·다운로드용 objectURL 정리 (안 하면 메모리에 계속 남는다)
  useEffect(() => {
    return () => {
      previews.forEach((url) => URL.revokeObjectURL(url));
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      if (projectUrl) URL.revokeObjectURL(projectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 언마운트 시 1회만 정리
  }, []);

  const authedFetch = async (input: string, init: RequestInit = {}) => {
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

  const acceptFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const images = Array.from(incoming).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) return;

    const next = [...files, ...images].slice(0, MAX_IMAGES);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((file) => URL.createObjectURL(file)));
    setErrorMessage("");
    setStoryboard(null);
    setStep("idle");
  };

  const removeAt = (target: number) => {
    const next = files.filter((_, i) => i !== target);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((file) => URL.createObjectURL(file)));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    acceptFiles(event.dataTransfer.files);
  };

  const handleGenerate = async () => {
    setErrorMessage("");
    setUploadedCount(0);
    setStoryboard(null);
    setThumbnailUrl("");
    setProjectUrl("");

    try {
      setStep("uploading");
      // 한 장씩 따로 올린다. 한 번에 묶어 보내면 장수가 늘어날수록 본문이 상한을
      // 넘기고, 어느 사진에서 실패했는지도 알 수 없다.
      const imageUrls: string[] = [];
      for (const [index, file] of files.entries()) {
        setUploadedCount(index);
        const dataUrl = await downscaleToDataUrl(file);
        const uploadResponse = await authedFetch("/api/shorts/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageDataUrls: [dataUrl] }),
        });
        const uploadResult = await readJson<{
          imageUrls?: string[];
          error?: string;
        }>(uploadResponse, "업로드에 실패했습니다.");
        if (!uploadResponse.ok || !uploadResult.imageUrls) {
          throw new Error(uploadResult.error ?? "업로드에 실패했습니다.");
        }
        imageUrls.push(...uploadResult.imageUrls);
      }
      setUploadedCount(files.length);

      setStep("analyzing");
      const analyzeResponse = await authedFetch("/api/shorts/from-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls }),
      });
      const board = await readJson<Storyboard & { error?: string }>(
        analyzeResponse,
        "시나리오 생성에 실패했습니다.",
      );
      if (!analyzeResponse.ok) {
        throw new Error(board.error ?? "시나리오 생성에 실패했습니다.");
      }
      setStoryboard(board);

      setStep("composing");
      const composeResponse = await authedFetch("/api/thumbnail/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backgroundUrl: imageUrls[0],
          title: board.thumbnailCopy,
        }),
      });
      if (composeResponse.ok) {
        setThumbnailUrl(URL.createObjectURL(await composeResponse.blob()));
      }

      // 로컬 렌더러(build_shorts.py)가 그대로 먹는 프로젝트 파일
      const project = new Blob(
        [JSON.stringify({ ...board, source: "web-upload" }, null, 2)],
        { type: "application/json" },
      );
      setProjectUrl(URL.createObjectURL(project));
      setStep("done");
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.",
      );
      setStep("error");
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
          쇼츠 제작은 로그인 후 이용하실 수 있습니다.
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

  const busy = step === "uploading" || step === "analyzing" || step === "composing";
  const canGenerate = files.length >= MIN_IMAGES && !busy;
  const busyLabel =
    step === "uploading"
      ? `이미지 업로드 중... (${Math.min(uploadedCount + 1, files.length)}/${files.length})`
      : STEP_LABEL[step];

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">
          이미지로 쇼츠 만들기
        </h1>
        <Link
          href="/thumbnail"
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          썸네일만 만들기 →
        </Link>
      </div>

      {/* 1단계: 업로드 */}
      <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          1. 사진 {MIN_IMAGES}~{MAX_IMAGES}장을 올려주세요
        </p>
        <p className="-mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          순서는 상관없어요. AI가 사진을 보고 한 이야기로 묶이는 것만 골라서,
          가장 재밌는 순서로 배치합니다. 안 어울리는 사진은 빼고 씁니다.
        </p>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors ${
            isDragging
              ? "border-black bg-zinc-100 dark:border-white dark:bg-zinc-900"
              : "border-zinc-300 dark:border-zinc-700"
          }`}
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            여기로 이미지를 끌어다 놓거나 눌러서 선택하세요
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            현재 {files.length}장 선택됨 (최대 {MAX_IMAGES}장)
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => acceptFiles(event.target.files)}
          />
        </div>

        {previews.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {previews.map((url, index) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 objectURL 미리보기 */}
                <img
                  src={url}
                  alt={`${index + 1}번째 이미지`}
                  className="aspect-[9/16] w-full rounded-lg object-cover"
                />
                <span className="absolute left-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white">
                  {index + 1}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeAt(index);
                  }}
                  className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white hover:bg-black"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={!canGenerate}
          className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {busy ? busyLabel : "바이럴 쇼츠 생성"}
        </button>
        {files.length > 0 && files.length < MIN_IMAGES && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {MIN_IMAGES}장 이상부터 생성할 수 있어요.
          </p>
        )}
        {errorMessage && (
          <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
        )}
      </section>

      {/* 2단계: 결과 */}
      {storyboard && (
        <section className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            2. 대본과 썸네일이 나왔어요
          </p>
          <p className="-mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            올린 {files.length}장 중 {storyboard.scenes.length}장을 골라
            {storyboard.scenes.length}개 장면으로 만들었어요.
            {files.length > storyboard.scenes.length &&
              " 빠진 사진은 이야기에 안 맞아 뺀 것이고, 다음 영상에 쓰시면 됩니다."}
          </p>

          <div className="flex flex-col gap-4 sm:flex-row">
            {thumbnailUrl && (
              <div className="sm:w-40">
                {/* eslint-disable-next-line @next/next/no-img-element -- blob objectURL */}
                <img
                  src={thumbnailUrl}
                  alt="썸네일 미리보기"
                  className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
                />
                <a
                  href={thumbnailUrl}
                  download="thumbnail.png"
                  className="mt-2 block rounded-full border border-zinc-300 px-3 py-1.5 text-center text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  썸네일 저장
                </a>
              </div>
            )}

            <div className="flex-1">
              <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                썸네일 문구: <span className="font-medium">{storyboard.thumbnailCopy}</span>
                {" · "}BGM: {storyboard.bgmMood}
              </p>
              <ol className="flex flex-col gap-2">
                {storyboard.scenes.map((scene) => (
                  <li
                    key={scene.index}
                    className="rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-800"
                  >
                    <span className="text-xs text-zinc-400">
                      장면 {scene.index} · SFX {scene.sfx} · 줌 {scene.kenBurns}
                    </span>
                    <p className="text-zinc-800 dark:text-zinc-200">{scene.narration}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              3. 영상(MP4)은 PC에서 뽑습니다
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              영상 합성은 30초 분량에 몇 분이 걸려서 웹 서버에서는 못 돌립니다. 아래
              프로젝트 파일을 받아서 PC에서 아래 명령만 실행하면 완성본이 나옵니다.
            </p>
            {projectUrl && (
              <a
                href={projectUrl}
                download="shorts-project.json"
                className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                프로젝트 파일 내려받기
              </a>
            )}
            <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-100">
              python .claude/skills/viral-shorts/build_shorts.py --project shorts-project.json
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}

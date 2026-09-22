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
const MAX_IMAGES = 10;

const STEP_LABEL: Record<Step, string> = {
  idle: "",
  uploading: "이미지 업로드 중...",
  analyzing: "AI가 이미지를 보고 대본 쓰는 중... (30초 정도)",
  composing: "썸네일 만드는 중...",
  done: "완성!",
  error: "",
};

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`${file.name} 을(를) 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });

export default function ShortsPage() {
  const { user, loading: userLoading } = useSupabaseUser();

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [step, setStep] = useState<Step>("idle");
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
    setStoryboard(null);
    setThumbnailUrl("");
    setProjectUrl("");

    try {
      setStep("uploading");
      const dataUrls = await Promise.all(files.map(readAsDataUrl));
      const uploadResponse = await authedFetch("/api/shorts/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrls: dataUrls }),
      });
      const uploadResult = await uploadResponse.json();
      if (!uploadResponse.ok) {
        throw new Error(uploadResult?.error ?? "업로드에 실패했습니다.");
      }
      const imageUrls: string[] = uploadResult.imageUrls;

      setStep("analyzing");
      const analyzeResponse = await authedFetch("/api/shorts/from-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls }),
      });
      const board = await analyzeResponse.json();
      if (!analyzeResponse.ok) {
        throw new Error(board?.error ?? "시나리오 생성에 실패했습니다.");
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
          1. 이미지 {MIN_IMAGES}~{MAX_IMAGES}장을 순서대로 올려주세요 (이야기 순서대로)
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
          {busy ? STEP_LABEL[step] : "바이럴 쇼츠 생성"}
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

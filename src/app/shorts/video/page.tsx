"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

// 사진 쇼츠(../page.tsx)와 같은 업로드 제약 재사용.
const MIN_IMAGES = 5;
const MAX_IMAGES = 15;

// 사진 쇼츠와 같은 이유로 업로드 전 1280px로 줄인다(Vercel 요청 본문 상한 회피).
// 알려진 한계: 그래서 영상 생성에도 원본이 아니라 이 축소본이 들어간다 — 화질이
// 사진 원본보다 떨어질 수 있다. 원본을 그대로 보존해 영상 생성에 쓰는 업로드
// 경로는 후속 작업이다(서명된 URL로 Storage에 직접 올리는 방식이 필요).
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

type JobStyle = "comic" | "jeju_travel" | "emotional" | "product_ad";

const STYLE_OPTIONS: { value: JobStyle; label: string }[] = [
  { value: "comic", label: "코믹 썰" },
  { value: "jeju_travel", label: "제주 여행 소개" },
  { value: "emotional", label: "감성 영상" },
  { value: "product_ad", label: "제품 광고" },
];

type JobStatus =
  | "idle"
  | "planning"
  | "generating"
  | "reviewable"
  | "editing"
  | "completed"
  | "failed";

type SceneStatus = "queued" | "generating" | "ready" | "selected" | "failed";

type Job = {
  id: string;
  status: JobStatus;
  provider: string | null;
  estimatedCostCents: number | null;
  maxBudgetCents: number | null;
  spentCents: number;
  error: string | null;
};

type Scene = {
  id: string;
  sceneIndex: number;
  sourceImageUrl: string;
  narration: string | null;
  subtitle: string | null;
  keyAction: string | null;
  cameraMotion: string | null;
  status: SceneStatus;
  videoUrl: string | null;
  error: string | null;
};

const money = (cents: number | null): string =>
  cents == null ? "-" : `$${(cents / 100).toFixed(2)}`;

const SCENE_STATUS_LABEL: Record<SceneStatus, string> = {
  queued: "대기 중",
  generating: "생성 중...",
  ready: "완성",
  selected: "선택됨",
  failed: "실패",
};

const loadImage = async (file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // 아래 <img> 경로로 대체
    }
  }
  const objectUrl = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`${file.name} 을(를) 읽지 못했습니다.`));
    el.src = objectUrl;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(objectUrl) };
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
    if (!ctx) throw new Error(`${file.name} 을(를) 변환하지 못했습니다.`);
    ctx.drawImage(image.source, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    image.release();
  }
};

export default function VideoShortsPage() {
  const { user, loading: userLoading } = useSupabaseUser();

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [keepOrder, setKeepOrder] = useState(false);
  const [useAllImages, setUseAllImages] = useState(false);
  const [style, setStyle] = useState<JobStyle>("comic");
  const [narrationEnabled, setNarrationEnabled] = useState(true);
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneActionError, setSceneActionError] = useState<Record<number, string>>({});
  const [busyScenes, setBusyScenes] = useState<Set<number>>(new Set());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const idempotencyKeyRef = useRef<string>("");

  useEffect(() => {
    return () => previews.forEach((url) => URL.revokeObjectURL(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 언마운트 시 1회만 정리
  }, []);

  const authedFetch = async (input: string, init: RequestInit = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("로그인이 필요합니다.");
    return fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.access_token}` },
    });
  };

  const acceptFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const images = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const next = [...files, ...images].slice(0, MAX_IMAGES);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
    setErrorMessage("");
    setJob(null);
    setScenes([]);
  };

  const removeAt = (index: number) => {
    const next = files.filter((_, i) => i !== index);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
  };

  // 작업이 진행 중일 때(계획 중이거나 장면이 생성 중일 때) 상태 조회 라우트를
  // 주기적으로 불러 화면을 최신으로 유지한다 — 이 호출 자체가 폴링 역할을 한다
  // (videoJobEngine.ts의 advanceScene 설명 참고).
  useEffect(() => {
    if (!job) return;
    const stillMoving =
      job.status === "planning" || scenes.some((s) => s.status === "generating");
    if (!stillMoving) return;

    const timer = setInterval(async () => {
      try {
        const res = await authedFetch(`/api/shorts/video/jobs/${job.id}`);
        if (!res.ok) return;
        const data = await res.json();
        setJob(data.job);
        setScenes(data.scenes);
      } catch {
        // 다음 틱에 다시 시도
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status, scenes.map((s) => s.status).join(",")]);

  const handleCreateJob = async () => {
    setErrorMessage("");
    setUploadProgress(0);
    setJob(null);
    setScenes([]);
    setSubmitting(true);
    idempotencyKeyRef.current = crypto.randomUUID();

    try {
      const imageUrls: string[] = [];
      for (const [index, file] of files.entries()) {
        setUploadProgress(index);
        const dataUrl = await downscaleToDataUrl(file);
        const res = await authedFetch("/api/shorts/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageDataUrls: [dataUrl] }),
        });
        const result = await res.json();
        if (!res.ok || !result.imageUrls) {
          throw new Error(result.error ?? "업로드에 실패했습니다.");
        }
        imageUrls.push(...result.imageUrls);
      }
      setUploadProgress(files.length);

      const res = await authedFetch("/api/shorts/video/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrls,
          idempotencyKey: idempotencyKeyRef.current,
          keepOrder,
          useAllImages,
          style,
          narrationEnabled,
          subtitleEnabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "작업 생성에 실패했습니다.");
      setJob(data.job);
      setScenes(data.scenes);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const generateScene = async (scene: Scene, regenerate: boolean) => {
    if (!job) return;
    if (regenerate && !confirm("이미 만든 장면을 다시 생성하면 비용이 다시 듭니다. 계속할까요?")) {
      return;
    }
    setBusyScenes((prev) => new Set(prev).add(scene.sceneIndex));
    setSceneActionError((prev) => ({ ...prev, [scene.sceneIndex]: "" }));
    try {
      const res = await authedFetch(
        `/api/shorts/video/jobs/${job.id}/scenes/${scene.sceneIndex}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ regenerate }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "장면 생성 요청에 실패했습니다.");
      setScenes((prev) => prev.map((s) => (s.sceneIndex === scene.sceneIndex ? data.scene : s)));
    } catch (err) {
      setSceneActionError((prev) => ({
        ...prev,
        [scene.sceneIndex]: err instanceof Error ? err.message : "알 수 없는 오류",
      }));
    } finally {
      setBusyScenes((prev) => {
        const next = new Set(prev);
        next.delete(scene.sceneIndex);
        return next;
      });
    }
  };

  const canSubmit = files.length >= MIN_IMAGES && !submitting;

  const usingRealProvider = job?.provider && job.provider !== "mock";

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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">AI 영상 쇼츠는 로그인 후 이용할 수 있습니다.</p>
        <Link href="/login" className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black">로그인</Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">AI 영상 쇼츠 (베타)</h1>
        <Link href="/shorts" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">사진 쇼츠로 →</Link>
      </div>

      <div className="w-full max-w-2xl rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        베타 기능입니다. 기본 설정은 비용이 들지 않는 모의(mock) 생성이며, 실제 영상 생성 공급자를
        서버에 연결하기 전까지는 진짜 동영상이 만들어지지 않습니다. 나레이션·자막·배경음악을 하나의
        MP4로 합치는 마지막 단계는 아직 없고, 지금은 장면별 클립 생성까지만 지원합니다.
      </div>

      <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">1. 사진 {MIN_IMAGES}~{MAX_IMAGES}장을 올려주세요</p>

        <div
          onDragOver={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(false); acceptFiles(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors ${isDragging ? "border-black bg-zinc-100 dark:border-white dark:bg-zinc-900" : "border-zinc-300 dark:border-zinc-700"}`}
        >
          <p className="text-sm text-zinc-600 dark:text-zinc-400">여기로 이미지를 끌어다 놓거나 눌러서 선택하세요</p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">현재 {files.length}장 선택됨 (최대 {MAX_IMAGES}장)</p>
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => acceptFiles(e.target.files)} />
        </div>

        {previews.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {previews.map((url, index) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 objectURL 미리보기 */}
                <img src={url} alt={`${index + 1}번째 이미지`} className="aspect-[9/16] w-full rounded-lg object-cover" />
                <span className="absolute left-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white">{index + 1}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); removeAt(index); }} className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white hover:bg-black">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 border-t border-zinc-200 pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 sm:grid-cols-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={keepOrder} onChange={(e) => setKeepOrder(e.target.checked)} />업로드 순서 유지 (AI가 순서를 못 바꿈)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={useAllImages} onChange={(e) => setUseAllImages(e.target.checked)} />모든 이미지 사용 (임의로 버리지 않음)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={narrationEnabled} onChange={(e) => setNarrationEnabled(e.target.checked)} />내레이션 사용</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={subtitleEnabled} onChange={(e) => setSubtitleEnabled(e.target.checked)} />자막 사용</label>
          <label className="flex items-center gap-2 sm:col-span-2">
            스타일
            <select value={style} onChange={(e) => setStyle(e.target.value as JobStyle)} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
              {STYLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
        </div>

        <button type="button" onClick={() => void handleCreateJob()} disabled={!canSubmit} className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black">
          {submitting ? `업로드·계획 생성 중... (${Math.min(uploadProgress + 1, files.length)}/${files.length})` : "장면 계획 만들기"}
        </button>
        {files.length > 0 && files.length < MIN_IMAGES && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{MIN_IMAGES}장 이상부터 만들 수 있어요.</p>
        )}
        {errorMessage && <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>}
      </section>

      {job && (
        <section className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">2. 장면별로 영상을 만드세요</p>
            <span className="text-xs text-zinc-400">작업 상태: {job.status}</span>
          </div>

          <div className="flex flex-wrap gap-4 rounded-lg bg-zinc-100 p-3 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            <span>공급자: {job.provider ?? "-"}{usingRealProvider ? "" : " (비용 없음)"}</span>
            <span>예상 비용: {money(job.estimatedCostCents)}</span>
            <span>예산 상한: {money(job.maxBudgetCents)}</span>
            <span>현재까지 사용: {money(job.spentCents)}</span>
          </div>
          {job.error && <p className="text-sm text-red-600 dark:text-red-400">{job.error}</p>}

          <ol className="flex flex-col gap-3">
            {scenes.map((scene) => {
              const isBusy = busyScenes.has(scene.sceneIndex);
              return (
                <li key={scene.id} className="flex gap-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {scene.videoUrl ? (
                    <video src={scene.videoUrl} controls className="h-32 w-20 shrink-0 rounded object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- 원본 스토리지 URL
                    <img src={scene.sourceImageUrl} alt={`장면 ${scene.sceneIndex}`} className="h-32 w-20 shrink-0 rounded object-cover" />
                  )}
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-zinc-400">장면 {scene.sceneIndex} · {SCENE_STATUS_LABEL[scene.status]}</span>
                    </div>
                    {scene.narration && <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">{scene.narration}</p>}
                    {scene.keyAction && <p className="mt-0.5 text-xs text-zinc-400">동작: {scene.keyAction}</p>}
                    {scene.error && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{scene.error}</p>}
                    {sceneActionError[scene.sceneIndex] && (
                      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{sceneActionError[scene.sceneIndex]}</p>
                    )}
                    <div className="mt-1 flex gap-2">
                      {(scene.status === "queued" || scene.status === "failed") && (
                        <button type="button" disabled={isBusy} onClick={() => void generateScene(scene, false)} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                          {isBusy ? "요청 중..." : "장면 생성"}
                        </button>
                      )}
                      {scene.status === "ready" && (
                        <>
                          <a href={scene.videoUrl ?? "#"} download className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">다운로드</a>
                          <button type="button" disabled={isBusy} onClick={() => void generateScene(scene, true)} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                            다시 만들기 (재과금)
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            모든 장면을 만든 뒤 나레이션·자막·배경음악을 합쳐 하나의 MP4로 만드는 기능은
            아직 없습니다(후속 범위). 지금은 장면별 클립을 개별적으로 내려받을 수 있어요.
          </p>
        </section>
      )}
    </div>
  );
}

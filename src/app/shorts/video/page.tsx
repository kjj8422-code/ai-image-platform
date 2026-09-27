"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { readJson } from "@/lib/readJson";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import { BGM_GROUPS, SFX_GROUPS, type BgmMood, type SfxCue } from "@/lib/audioCatalog";
import { AudioHelp } from "@/components/AudioHelp";
import { AudioPreviewButton } from "@/components/AudioPreviewButton";
import { validClipFile, UPLOADED_CLIP_MODEL } from "@/lib/sceneClipUpload";
import { validateBrowserClip } from "@/lib/validateBrowserClip";
import { moveItem, VISUAL_LIMITS } from "@/lib/videoSceneEditing";
import { MOCK_PROVIDER_MODEL } from "@/lib/videoBudget";
import type { SceneStyle } from "@/lib/characterShorts";
import { STYLE_OPTIONS, BGM_MOOD_BY_STYLE } from "@/lib/shortsUiLabels";

// 사진 쇼츠(../page.tsx)와 같은 업로드 제약 재사용.
const MIN_IMAGES = 5;
const MAX_IMAGES = 15;

// 영상 생성 모델에 넣을 입력이 곧 결과 화질이라, 사진 쇼츠처럼 1280px로 줄이지
// 않고 원본 해상도를 그대로 쓴다. 대신 서버(Vercel 함수, 요청 본문 4.5MB 상한)를
// 거치지 않고 서명된 URL로 Supabase Storage에 직접 올린다 — /api/shorts/video/upload-url
// 참고. 재인코딩 시에는 화질 손실을 최소화하려고 높은 JPEG 품질을 쓴다.
const JPEG_QUALITY = 0.95;

type JobStyle = SceneStyle;

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
  narrationEnabled: boolean;
  subtitleEnabled: boolean;
};

type Scene = {
  id: string;
  sceneIndex: number;
  sourceImageUrl: string;
  narration: string | null;
  subtitle: string | null;
  keyAction: string | null;
  cameraMotion: string | null;
  preserveNotes: string | null;
  sfx: SfxCue;
  status: SceneStatus;
  videoUrl: string | null;
  providerModel: string | null;
  // 영상은 나왔는데 우리 저장소로 옮기다 실패하면 여기 공급자 임시 주소가 남는다.
  providerRawUrl?: string | null;
  error: string | null;
};

// 이미 돈을 낸 영상을 서버가 다시 저장해 보는 중인 장면. 이것도 "진행 중"으로 본다.
const isRetryingSave = (scene: Scene): boolean =>
  scene.status === "failed" && Boolean(scene.providerRawUrl) && !scene.videoUrl;

const isMockScene = (scene: Scene): boolean =>
  scene.providerModel === MOCK_PROVIDER_MODEL || scene.providerModel == null;

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

// EXIF 회전 정보를 반영해 캔버스에 다시 그린다(loadImage가 이미 방향을 바로잡아
// 주므로 그대로 그리기만 하면 된다). 크기는 원본 그대로 유지한다 — 이게 사진
// 쇼츠의 downscaleToDataUrl과 다른 점이다.
const toOrientedBlob = async (
  file: File,
): Promise<{ blob: Blob; extension: string }> => {
  const image = await loadImage(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(`${file.name} 을(를) 변환하지 못했습니다.`);
    ctx.drawImage(image.source, 0, 0, image.width, image.height);

    const isPng = file.type === "image/png";
    const mime = isPng ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, isPng ? undefined : JPEG_QUALITY),
    );
    if (!blob) throw new Error(`${file.name} 을(를) 변환하지 못했습니다.`);
    return { blob, extension: isPng ? "png" : "jpg" };
  } finally {
    image.release();
  }
};

export default function VideoShortsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
          <p className="text-sm text-zinc-500">불러오는 중...</p>
        </div>
      }
    >
      <VideoShortsPageInner />
    </Suspense>
  );
}

function VideoShortsPageInner() {
  const searchParams = useSearchParams();
  const jobIdFromUrl = searchParams.get("job");
  const { user, loading: userLoading } = useSupabaseUser();

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [keepOrder, setKeepOrder] = useState(true);
  const [useAllImages, setUseAllImages] = useState(false);
  const [style, setStyle] = useState<JobStyle>("comic");
  const [narrationEnabled, setNarrationEnabled] = useState(true);
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);
  // 스타일을 바꾸면 그 스타일의 기본 무드로 다시 맞춘다. 사용자가 직접 고른
  // 뒤에는 (아래 <select>에서) 스타일을 또 바꾸기 전까지 그 선택을 존중한다.
  const [bgmMood, setBgmMood] = useState<BgmMood>(BGM_MOOD_BY_STYLE.comic);

  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneActionError, setSceneActionError] = useState<Record<number, string>>({});
  const [busyScenes, setBusyScenes] = useState<Set<number>>(new Set());

  const reorderLockRef = useRef(false);
  const sceneRevisionRef = useRef(0);
  const pendingSceneMutations = useRef(0);
  const [reorderNotice, setReorderNotice] = useState("");
  const [visualEdits, setVisualEdits] = useState<Record<string, Partial<Pick<Scene, "keyAction" | "cameraMotion" | "preserveNotes">>>>({});
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
    if (!incoming || submitting || job) return;
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

  const moveUpload = (index: number, direction: -1 | 1) => {
    if (submitting || job) return;
    setFiles(prev => moveItem(prev, index, direction));
    setPreviews(prev => moveItem(prev, index, direction));
    setKeepOrder(true);
  };

  const removeAt = (index: number) => {
    if (submitting || job) return;
    const next = files.filter((_, i) => i !== index);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
  };

  const [loadingExistingJob, setLoadingExistingJob] = useState(Boolean(jobIdFromUrl));

  // /shorts/video/history에서 "?job=<id>"로 들어오면 그 작업을 불러온다.
  // 소유자가 아니거나 없는 작업이면 서버가 404를 주고, 그대로 새 작업 화면으로 둔다.
  useEffect(() => {
    if (!jobIdFromUrl || !user) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await authedFetch(`/api/shorts/video/jobs/${jobIdFromUrl}`);
        const data = await readJson(res);
        if (!res.ok) throw new Error(data.error ?? "작업을 불러오지 못했습니다.");
        if (!cancelled) {
          setJob(data.job);
          setScenes(data.scenes);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "작업을 불러오지 못했습니다.");
        }
      } finally {
        if (!cancelled) setLoadingExistingJob(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobIdFromUrl, user]);

  // 작업이 진행 중일 때(계획 중이거나 장면이 생성 중일 때) 상태 조회 라우트를
  // 주기적으로 불러 화면을 최신으로 유지한다 — 이 호출 자체가 폴링 역할을 한다
  // (videoJobEngine.ts의 advanceScene 설명 참고).
  useEffect(() => {
    if (!job) return;
    const stillMoving =
      job.status === "planning" ||
      scenes.some((s) => s.status === "generating" || isRetryingSave(s));
    if (!stillMoving) return;

    const timer = setInterval(async () => {
      if (reorderLockRef.current || pendingSceneMutations.current) return;
      const revision = sceneRevisionRef.current;
      try {
        const res = await authedFetch(`/api/shorts/video/jobs/${job.id}`);
        if (!res.ok) return;
        const data = await readJson(res);
        if (reorderLockRef.current || pendingSceneMutations.current || revision !== sceneRevisionRef.current) return;
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
      // 1) 원본 해상도를 유지한 채(EXIF 방향만 바로잡아) blob으로 변환한다.
      const blobs: { blob: Blob; extension: string }[] = [];
      for (const [index, file] of files.entries()) {
        setUploadProgress(index);
        blobs.push(await toOrientedBlob(file));
      }

      // 2) 서명된 업로드 URL을 한 번에 발급받는다(우리 서버는 URL만 내주고,
      // 실제 파일 바이트는 아래 3)에서 브라우저가 Storage로 직접 보낸다).
      const urlRes = await authedFetch("/api/shorts/video/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extensions: blobs.map((b) => b.extension) }),
      });
      const urlData = await readJson(urlRes);
      if (!urlRes.ok || !urlData.uploads) {
        throw new Error(urlData.error ?? "업로드 준비에 실패했습니다.");
      }
      const uploads: { path: string; token: string; publicUrl: string }[] =
        urlData.uploads;

      // 3) 각 파일을 자신의 서명된 URL로 직접 올린다.
      const imageUrls: string[] = [];
      for (const [index, { blob }] of blobs.entries()) {
        setUploadProgress(index);
        const { path, token } = uploads[index];
        const { error } = await supabase.storage
          .from("gallery")
          .uploadToSignedUrl(path, token, blob, { contentType: blob.type });
        if (error) throw new Error(`${files[index].name} 업로드 실패: ${error.message}`);
        imageUrls.push(uploads[index].publicUrl);
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? "작업 생성에 실패했습니다.");
      setJob(data.job);
      setScenes(data.scenes);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  // provider: "mock" = 1차 무료 미리보기, "real" = 2차 실제 생성(비용 발생).
  // 이미 ready/selected인 장면을 다시 제출하는 거라면(=미리보기를 진짜로 바꾸는
  // 것도 포함) regenerate:true가 필요하다.
  const generateScene = async (
    scene: Scene,
    provider: "mock" | "real",
    options: { silent?: boolean } = {},
  ) => {
    if (!job || reorderLockRef.current) return;
    const regenerate = scene.status === "ready" || scene.status === "selected";
    if (
      provider === "real" &&
      !options.silent &&
      !confirm(
        `장면 ${scene.sceneIndex}을(를) 실제로 생성합니다 (예상 비용 ${money(perSceneCostCents)}). 계속할까요?`,
      )
    ) {
      return;
    }
    if (hasSceneEdits(scene)) {
      const saved = await saveSceneEdit(scene);
      if (!saved) return false;
      scene = saved;
    }
    setBusyScenes((prev) => new Set(prev).add(scene.sceneIndex));
    setSceneActionError((prev) => ({ ...prev, [scene.sceneIndex]: "" }));
    pendingSceneMutations.current += 1;
    sceneRevisionRef.current += 1;
    try {
      const res = await authedFetch(
        `/api/shorts/video/jobs/${job.id}/scenes/${scene.sceneIndex}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ regenerate, provider, sceneId: scene.id }),
        },
      );
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? "장면 생성 요청에 실패했습니다.");
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? data.scene : s)));
      return true;
    } catch (err) {
      setSceneActionError((prev) => ({
        ...prev,
        [scene.sceneIndex]: err instanceof Error ? err.message : "알 수 없는 오류",
      }));
      return false;
    } finally {
      pendingSceneMutations.current -= 1;
      sceneRevisionRef.current += 1;
      setBusyScenes((prev) => {
        const next = new Set(prev);
        next.delete(scene.sceneIndex);
        return next;
      });
    }
  };

  const [batchBusy, setBatchBusy] = useState<"mock" | "real" | null>(null);

  // "1차: 무료 미리보기" — 아직 안 만들었거나 실패한 장면 전부를 mock으로.
  // "2차: 진짜 최종 생성" — 전체 장면을 실제 공급자로(이미 만든 미리보기는
  // 재생성 취급). 한 번만 확인받고 나머지는 조용히 진행한다.
  const batchGenerate = async (provider: "mock" | "real") => {
    if (!job || reorderLockRef.current) return;
    const targets =
      provider === "mock"
        ? scenes.filter((s) => s.status === "queued" || s.status === "failed")
        : scenes.filter((s) => s.status !== "generating" && s.providerModel !== UPLOADED_CLIP_MODEL);
    if (targets.length === 0) return;

    if (provider === "real") {
      const estimate = money(perSceneCostCents == null ? null : targets.length * perSceneCostCents);
      if (
        !confirm(
          `장면 ${targets.length}개를 실제로 생성합니다. 예상 총 비용 약 ${estimate}. 계속할까요?`,
        )
      ) {
        return;
      }
    }

    setBatchBusy(provider);
    try {
      for (const scene of targets) {
        // 공급자 쪽 요청 속도 제한을 지키려고 병렬이 아니라 순차로 진행한다.
        await generateScene(scene, provider, { silent: true });
      }
    } finally {
      setBatchBusy(null);
    }
  };

  const [reorderBusy, setReorderBusy] = useState(false);

  const moveScene = async (currentIndex: number, direction: -1 | 1) => {
    if (!job || reorderLockRef.current || pendingSceneMutations.current || reorderLocked) return;
    const otherIndex = currentIndex + direction;
    if (otherIndex < 0 || otherIndex >= scenes.length) return;
    const order = scenes.map((s) => s.id);
    [order[currentIndex], order[otherIndex]] = [order[otherIndex], order[currentIndex]];

    reorderLockRef.current = true;
    sceneRevisionRef.current += 1;
    setReorderBusy(true);
    setReorderNotice("순서를 저장하는 중…");
    setErrorMessage("");
    try {
      const res = await authedFetch(`/api/shorts/video/jobs/${job.id}/scenes/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order, expectedOrder: scenes.map(s => s.id) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? "순서를 바꾸지 못했습니다.");
      setScenes(data.scenes);
      // Drafts remain keyed by immutable scene ID while display indices change.
      setReorderNotice("순서가 저장되었습니다. 사진·설명·대본이 함께 이동합니다.");
      setSceneActionError({});
    } catch (err) {
      setReorderNotice("");
      setErrorMessage(err instanceof Error ? err.message : "순서 변경 중 오류가 발생했습니다.");
    } finally {
      sceneRevisionRef.current += 1;
      reorderLockRef.current = false;
      setReorderBusy(false);
    }
  };

  // 아직 안 만들었거나(대기) 실패한 장면은 생성 전에 나레이션/자막을 직접
  // 고칠 수 있다 — 비용이 안 드는 작업이라 재생성과 분리해뒀다.
  const [editedText, setEditedText] = useState<Record<string, string>>({});
  const [savingScenes, setSavingScenes] = useState<Set<number>>(new Set());

  const saveSceneEdit = async (scene: Scene) => {
    if (!job || reorderLockRef.current) return;
    const narration = editedText[scene.id] ?? scene.narration ?? "";
    setSavingScenes((prev) => new Set(prev).add(scene.sceneIndex));
    setSceneActionError((prev) => ({ ...prev, [scene.sceneIndex]: "" }));
    pendingSceneMutations.current += 1;
    sceneRevisionRef.current += 1;
    try {
      const res = await authedFetch(
        `/api/shorts/video/jobs/${job.id}/scenes/${scene.sceneIndex}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sceneId: scene.id, narration, ...(job.subtitleEnabled ? { subtitle: narration } : {}), ...visualEdits[scene.id] }),
        },
      );
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? "수정에 실패했습니다.");
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? data.scene : s)));
      setVisualEdits(prev => { const next = { ...prev }; delete next[scene.id]; return next; });
      setEditedText((prev) => {
        const next = { ...prev };
        delete next[scene.id];
        return next;
      });
      return data.scene as Scene;
    } catch (err) {
      setSceneActionError((prev) => ({
        ...prev,
        [scene.sceneIndex]: err instanceof Error ? err.message : "알 수 없는 오류",
      }));
    } finally {
      pendingSceneMutations.current -= 1;
      sceneRevisionRef.current += 1;
      setSavingScenes((prev) => {
        const next = new Set(prev);
        next.delete(scene.sceneIndex);
        return next;
      });
    }
  };

  const saveSceneSfx = async (scene: Scene, sfx: SfxCue) => {
    if (!job || reorderLockRef.current) return;
    setSavingScenes(prev => new Set(prev).add(scene.sceneIndex));
    setSceneActionError((prev) => ({ ...prev, [scene.sceneIndex]: "" }));
    pendingSceneMutations.current += 1;
    sceneRevisionRef.current += 1;
    try {
      const res = await authedFetch(
        `/api/shorts/video/jobs/${job.id}/scenes/${scene.sceneIndex}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sfx, sceneId: scene.id }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "효과음 변경에 실패했습니다.");
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? data.scene : s)));
    } catch (err) {
      setSceneActionError((prev) => ({
        ...prev,
        [scene.sceneIndex]: err instanceof Error ? err.message : "알 수 없는 오류",
      }));
    } finally {
      pendingSceneMutations.current -= 1;
      sceneRevisionRef.current += 1;
      setSavingScenes(prev => { const next = new Set(prev); next.delete(scene.sceneIndex); return next; });
    }
  };

  // "다른 대본" — 이 장면 이미지 한 장만 다시 보내 나레이션/자막/효과음을 새로
  // 뽑는다. 영상 클립과는 무관한 Claude 호출이라 장면이 어떤 상태든 눌러도 된다.
  // 실제 비용이 드는 호출이라 버튼 라벨에 비용을 표시해 클릭 자체를 승인으로 본다.
  const [rewritingScenes, setRewritingScenes] = useState<Set<number>>(new Set());

  const rewriteScene = async (scene: Scene) => {
    if (!job || reorderLockRef.current) return;
    setRewritingScenes((prev) => new Set(prev).add(scene.sceneIndex));
    setSceneActionError((prev) => ({ ...prev, [scene.sceneIndex]: "" }));
    pendingSceneMutations.current += 1;
    sceneRevisionRef.current += 1;
    try {
      const res = await authedFetch(
        `/api/shorts/video/jobs/${job.id}/scenes/${scene.sceneIndex}/rewrite`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sceneId: scene.id }) },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "다른 대본을 받지 못했습니다.");
      setScenes((prev) => prev.map((s) => (s.id === scene.id ? data.scene : s)));
      setEditedText((prev) => {
        const next = { ...prev };
        delete next[scene.id];
        return next;
      });
    } catch (err) {
      setSceneActionError((prev) => ({
        ...prev,
        [scene.sceneIndex]: err instanceof Error ? err.message : "알 수 없는 오류",
      }));
    } finally {
      pendingSceneMutations.current -= 1;
      sceneRevisionRef.current += 1;
      setRewritingScenes((prev) => {
        const next = new Set(prev);
        next.delete(scene.sceneIndex);
        return next;
      });
    }
  };

  const [uploadingScene, setUploadingScene] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState("");
  const uploadSceneClip = async (scene: Scene, file: File) => {
    if (!job || reorderLockRef.current || pendingSceneMutations.current || reorderLocked) return;
    if (!validClipFile(file.name, file.size)) { setSceneActionError(prev => ({...prev,[scene.sceneIndex]:"50MB 이하 MP4 파일을 선택하세요."})); return; }
    if (scene.videoUrl && !confirm("이 장면을 선택한 영상으로 교체할까요? 설명과 대본은 유지됩니다.")) return;
    setUploadingScene(scene.id);
    setUploadNotice("영상 파일 확인 중…");
    setSceneActionError(prev => ({...prev,[scene.sceneIndex]:""}));
    pendingSceneMutations.current += 1;
    sceneRevisionRef.current += 1;
    try {
      await validateBrowserClip(file);
      const endpoint = `/api/shorts/video/jobs/${job.id}/scenes/${scene.sceneIndex}/clip`;
      const signedResponse = await authedFetch(endpoint, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"sign",sceneId:scene.id,name:file.name,size:file.size})});
      const signed = await readJson(signedResponse);
      if (!signedResponse.ok) throw new Error(signed.error ?? "업로드 준비에 실패했습니다.");
      setUploadNotice("영상을 업로드하고 있습니다. 창을 닫지 마세요…");
      const { error } = await supabase.storage.from("gallery").uploadToSignedUrl(signed.path,signed.token,file,{contentType:"video/mp4",upsert:false});
      if (error) throw error;
      setUploadNotice("장면에 연결하는 중…");
      const response = await authedFetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"complete",sceneId:scene.id,path:signed.path,version:signed.version})});
      const result = await readJson(response);
      if (!response.ok) throw new Error(result.error ?? "영상 연결에 실패했습니다.");
      setScenes(prev=>prev.map(item=>item.id===scene.id?result.scene:item));
      setUploadNotice(`장면 ${scene.sceneIndex}에 영상을 연결했습니다. AI 생성 비용은 발생하지 않습니다.`);
    } catch(err) {
      setUploadNotice("");
      setSceneActionError(prev=>({...prev,[scene.sceneIndex]:err instanceof Error?err.message:"업로드 실패"}));
    } finally {
      pendingSceneMutations.current -= 1;
      sceneRevisionRef.current += 1;
      setUploadingScene(null);
    }
  };

  const hasSceneEdits = (scene: Scene) =>
    (editedText[scene.id] !== undefined && editedText[scene.id] !== (scene.narration ?? "")) ||
    Object.entries(visualEdits[scene.id] ?? {}).some(([key, value]) => value !== (scene[key as "keyAction" | "cameraMotion" | "preserveNotes"] ?? ""));
  const hasUnsavedEdits = scenes.some(hasSceneEdits);
  const reorderLocked = Boolean(uploadingScene) || reorderBusy || Boolean(batchBusy) || busyScenes.size > 0 || savingScenes.size > 0 || rewritingScenes.size > 0 || scenes.some(s => s.status === "generating" || isRetryingSave(s));
  const canSubmit = files.length >= MIN_IMAGES && !submitting;

  // 모든 장면이 길이가 같아(SCENE_DURATION_SECONDS) job.estimatedCostCents를
  // 장면 수로 나누면 장면 1개의 실제 생성 비용과 정확히 같다 — 버튼에 그대로 쓴다.
  const perSceneCostCents =
    job?.estimatedCostCents != null && scenes.length > 0
      ? Math.round(job.estimatedCostCents / scenes.length)
      : null;

  const readyScenes = scenes.filter((s) => s.status === "ready");
  const allScenesReady = scenes.length > 0 && readyScenes.length === scenes.length;

  // build_shorts.py가 그대로 읽을 수 있는 형식으로 만든다(사진 쇼츠가 받는 것과
  // 같은 shorts-project.json 구조 + scenes[].videoUrl). 이 파이프라인은 나레이션
  // 실측 길이로 장면 타이밍을 맞추므로, 나레이션을 껐던 작업은 지원하지 않는다.
  const projectUrl = useMemo(() => {
    if (!job || !job.narrationEnabled || !allScenesReady || hasUnsavedEdits) return "";
    const project = {
      thumbnailCopy: "",
      bgmMood,
      scenes: scenes.map((scene) => ({
        index: scene.sceneIndex,
        narration: scene.narration ?? "",
        sfx: scene.sfx,
        kenBurns: "in",
        videoUrl: scene.videoUrl,
      })),
      source: "web-upload-video",
    };
    const json = JSON.stringify(project, null, 2);
    return `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.narrationEnabled, allScenesReady, scenes, bgmMood, hasUnsavedEdits]);

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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">AI 영상 쇼츠는 로그인 후 이용할 수 있습니다.</p>
        <Link href="/login" className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black">로그인</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">AI 영상 쇼츠 (베타)</h1>
        <div className="flex items-center gap-3">
          <Link href="/shorts/video/history" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">내 영상 목록</Link>
          <Link href="/shorts" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">사진 쇼츠로 →</Link>
        </div>
      </div>

      {loadingExistingJob && (
        <p className="w-full max-w-2xl text-sm text-zinc-500">이전 작업을 불러오는 중...</p>
      )}

      <div className="w-full max-w-2xl rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        베타 기능입니다. 장면 계획을 세운 뒤 <strong>1차: 무료 미리보기</strong>로 먼저 타이밍·순서·대사를
        확인하고, 마음에 들면 <strong>2차: 진짜 최종 생성</strong>으로 실제 비용을 들여 영상을 만드세요.
        최종 MP4(나레이션·자막·배경음악 합성)는 PC에서 뽑습니다.
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
          <input disabled={submitting || Boolean(job)} ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => acceptFiles(e.target.files)} />
        </div>

        {previews.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {previews.map((url, index) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 objectURL 미리보기 */}
                <img src={url} alt={`${index + 1}번째 이미지`} className="aspect-[9/16] w-full rounded-lg object-cover" />
                <div className="mt-1 flex justify-between gap-1">
                  <button type="button" disabled={submitting || Boolean(job) || index === 0} onClick={() => moveUpload(index, -1)} className="rounded border px-2 py-1 text-xs disabled:opacity-30" aria-label={'사진 ' + (index + 1) + ' 앞으로'}>← 앞</button>
                  <button type="button" disabled={submitting || Boolean(job) || index === files.length - 1} onClick={() => moveUpload(index, 1)} className="rounded border px-2 py-1 text-xs disabled:opacity-30" aria-label={'사진 ' + (index + 1) + ' 뒤로'}>뒤 →</button>
                </div>
                <span className="absolute left-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white">{index + 1}</span>
                <button type="button" disabled={submitting || Boolean(job)} onClick={(e) => { e.stopPropagation(); removeAt(index); }} className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] font-medium text-white hover:bg-black">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 border-t border-zinc-200 pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 sm:grid-cols-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={keepOrder} onChange={(e) => setKeepOrder(e.target.checked)} />업로드 순서 유지 (AI가 순서를 못 바꿈)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={useAllImages} onChange={(e) => setUseAllImages(e.target.checked)} />모든 이미지 사용 (임의로 버리지 않음)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={narrationEnabled} onChange={(e) => setNarrationEnabled(e.target.checked)} />내레이션 사용</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={subtitleEnabled} onChange={(e) => setSubtitleEnabled(e.target.checked)} />자막 사용</label>
          <label className="flex items-center gap-2">
            스타일
            <select
              value={style}
              onChange={(e) => {
                const next = e.target.value as JobStyle;
                setStyle(next);
                setBgmMood(BGM_MOOD_BY_STYLE[next]);
              }}
              className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            >
              {STYLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2">
              배경음악
              <select value={bgmMood} onChange={(e) => setBgmMood(e.target.value as BgmMood)} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                {BGM_GROUPS.map(({ group, items }) => (
                  <optgroup key={group} label={group}>
                    {items.map((entry) => <option key={entry.mood} value={entry.mood}>{entry.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <AudioPreviewButton kind="bgm" name={bgmMood} />
          </div>
        </div>
        <AudioHelp />

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
            <span>예상 총 비용(실제 생성 기준): {money(job.estimatedCostCents)}</span>
            <span>예산 상한: {money(job.maxBudgetCents)}</span>
            <span>실제로 쓴 금액: {money(job.spentCents)}</span>
          </div>
          {job.error && <p className="text-sm text-red-600 dark:text-red-400">{job.error}</p>}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={reorderLocked}
              onClick={() => void batchGenerate("mock")}
              className="rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {batchBusy === "mock" ? "미리보기 생성 중..." : "1차: 전체 무료 미리보기 ($0.00)"}
            </button>
            <button
              type="button"
              disabled={reorderLocked || !scenes.some(s => s.providerModel !== UPLOADED_CLIP_MODEL)}
              onClick={() => void batchGenerate("real")}
              className="rounded-full bg-black px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {batchBusy === "real"
                ? "실제 생성 중..."
                : `2차: 업로드 제외 AI 생성 (${money(perSceneCostCents == null ? null : scenes.filter(s => s.providerModel !== UPLOADED_CLIP_MODEL && s.status !== "generating").length * perSceneCostCents)})`}
            </button>
          </div>

          <p className="text-xs text-zinc-500">위·아래 버튼으로 사진·설명·대본을 함께 이동합니다. 영상 생성·저장 중에는 순서 변경을 잠시 막습니다. 저장되지 않은 수정은 생성 전에 자동 저장됩니다.</p>
          <p className="text-xs text-zinc-500">장면 연결: 현재 순서를 기준으로 앞뒤 동작과 카메라 방향을 생성 지시에 반영합니다. 서로 다른 사진의 완벽한 연속 촬영 효과를 보장하지는 않습니다.</p>
          <p role="status" className="text-sm text-blue-600">{reorderNotice}</p>
          <p className="text-xs text-zinc-500">Higgsfield에서 만든 MP4를 각 장면에 넣을 수 있습니다. 업로드한 장면은 전체 AI 생성에서 제외됩니다. 업로드 자체는 AI 생성료가 없으며 저장소 사용량은 늘어납니다.</p>
          <p role="status" className="text-sm text-blue-600">{uploadNotice}</p>
          {hasUnsavedEdits && <p className="text-xs text-amber-700">수정한 설명·대본을 저장하면 최종 프로젝트에 반영됩니다.</p>}
          <ol className="flex flex-col gap-3">
            {scenes.map((scene, index) => {
              const isBusy = busyScenes.has(scene.sceneIndex) || Boolean(uploadingScene);
              const isSaving = savingScenes.has(scene.sceneIndex);
              const draft = editedText[scene.id] ?? scene.narration ?? "";
              const dirty = hasSceneEdits(scene);
              const visual = { ...scene, ...visualEdits[scene.id] };
              const visualLocked = reorderBusy || Boolean(batchBusy) || rewritingScenes.has(scene.sceneIndex) || isBusy || isSaving || scene.status === "generating" || isRetryingSave(scene);
              const needsFirstGenerate = scene.status === "queued" || scene.status === "failed";
              return (
                <li key={scene.id} className="flex gap-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <button
                      type="button"
                      disabled={reorderLocked || index === 0}
                      onClick={() => void moveScene(index, -1)}
                      className="rounded border border-zinc-300 px-1.5 text-xs leading-5 hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      title="위로" aria-label={`장면 ${scene.sceneIndex} 위로 이동`}
                    >
                      ▲
                    </button>
                    {scene.videoUrl ? (
                      <video src={scene.videoUrl} controls className="h-32 w-20 rounded object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- 원본 스토리지 URL
                      <img src={scene.sourceImageUrl} alt={`장면 ${scene.sceneIndex}`} className="h-32 w-20 rounded object-cover" />
                    )}
                    <button
                      type="button"
                      disabled={reorderLocked || index === scenes.length - 1}
                      onClick={() => void moveScene(index, 1)}
                      className="rounded border border-zinc-300 px-1.5 text-xs leading-5 hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      title="아래로" aria-label={`장면 ${scene.sceneIndex} 아래로 이동`}
                    >
                      ▼
                    </button>
                  </div>
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-zinc-400">
                        장면 {scene.sceneIndex} · {SCENE_STATUS_LABEL[scene.status]}
                        {scene.status === "ready" && (isMockScene(scene) ? " (미리보기)" : " (실제 생성)")}
                      </span>
                    </div>
                    <label htmlFor={'visual-' + scene.id} className="mt-2 block font-medium">원하는 장면 설명 · 화면과 동작</label>
                    <textarea id={'visual-' + scene.id} value={visual.keyAction ?? ""} disabled={visualLocked}
                      onChange={e => setVisualEdits(prev => ({ ...prev, [scene.id]: { ...prev[scene.id], keyAction: e.target.value } }))}
                      rows={3} maxLength={VISUAL_LIMITS.keyAction} placeholder="예: 인물이 왼쪽에서 오른쪽으로 천천히 걸으며 카메라를 바라본다."
                      className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700" />
                    <label htmlFor={'camera-' + scene.id} className="mt-1 block text-xs">구도·카메라 움직임</label>
                    <input id={'camera-' + scene.id} value={visual.cameraMotion ?? ""} disabled={visualLocked} maxLength={VISUAL_LIMITS.cameraMotion}
                      onChange={e => setVisualEdits(prev => ({ ...prev, [scene.id]: { ...prev[scene.id], cameraMotion: e.target.value } }))}
                      placeholder="예: 인물 상반신, 천천히 따라가기" className="mt-1 w-full rounded border bg-transparent px-2 py-1 dark:border-zinc-700" />
                    <label htmlFor={'preserve-' + scene.id} className="mt-1 block text-xs">계속 유지할 인물·의상·소품</label>
                    <input id={'preserve-' + scene.id} value={visual.preserveNotes ?? ""} disabled={visualLocked} maxLength={VISUAL_LIMITS.preserveNotes}
                      onChange={e => setVisualEdits(prev => ({ ...prev, [scene.id]: { ...prev[scene.id], preserveNotes: e.target.value } }))}
                      className="mt-1 w-full rounded border bg-transparent px-2 py-1 dark:border-zinc-700" />
                    {scene.videoUrl && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">장면 설명 변경은 다음 생성부터 적용됩니다. 기존 영상은 자동으로 다시 만들지 않습니다.</p>}
                    <label htmlFor={'narration-' + scene.id} className="mt-3 block font-medium">나레이션 · 대본 (읽어 줄 말)</label>
                    {/* 나레이션은 영상 클립과 분리된 데이터라 장면 상태와 무관하게 언제나 고칠 수 있다. */}
                    <textarea
                      id={`narration-${scene.id}`}
                      disabled={reorderBusy || Boolean(batchBusy) || isBusy || isSaving || rewritingScenes.has(scene.sceneIndex)}
                      value={draft}
                      onChange={(e) =>
                        setEditedText((prev) => ({ ...prev, [scene.id]: e.target.value }))
                      }
                      rows={2}
                      placeholder="나레이션/대사"
                      className="mt-0.5 w-full resize-y rounded border border-zinc-300 bg-transparent px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                    />

                    <div className="mt-1 flex items-center gap-1.5">
                      <label className="text-xs text-zinc-400">효과음</label>
                      <select
                        disabled={reorderBusy || Boolean(batchBusy) || isBusy || isSaving || rewritingScenes.has(scene.sceneIndex)}
                        value={scene.sfx}
                        onChange={(e) => void saveSceneSfx(scene, e.target.value as SfxCue)}
                        className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700"
                      >
                        {SFX_GROUPS.map(({ group, items }) => (
                        <optgroup key={group} label={group}>
                          {items.map((entry) => <option key={entry.cue} value={entry.cue}>{entry.label}</option>)}
                        </optgroup>
                      ))}
                      </select>
                      <AudioPreviewButton kind="sfx" name={scene.sfx} />
                    </div>
                    {scene.error && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{scene.error}</p>}
                    {sceneActionError[scene.sceneIndex] && (
                      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{sceneActionError[scene.sceneIndex]}</p>
                    )}
                    <div className="my-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
                      <label className="block text-xs font-semibold" htmlFor={'clip-' + scene.id}>Higgsfield·내 영상 MP4 넣기</label>
                      <input id={'clip-' + scene.id} type="file" accept="video/mp4,.mp4" disabled={reorderLocked} className="mt-2 block w-full text-xs disabled:opacity-50" onChange={e=>{const file=e.target.files?.[0];e.target.value="";if(file) void uploadSceneClip(scene,file);}} />
                      <p className="mt-1 text-xs text-zinc-500">MP4 · 최대 50MB · 세로 9:16 권장. 원본 영상 소리는 최종 합성에서 제외되고 설정한 나레이션·음악을 사용합니다.</p>
                      {scene.providerModel === UPLOADED_CLIP_MODEL && <p className="mt-1 text-xs text-blue-700">업로드한 영상 사용 중 · AI 생성료 $0</p>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {dirty && (
                        <button type="button" disabled={isSaving || reorderBusy || visualLocked} onClick={() => void saveSceneEdit(scene)} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                          {isSaving ? "저장 중..." : "설명·대본 저장"}
                        </button>
                      )}
                      <button type="button" disabled={rewritingScenes.has(scene.sceneIndex) || reorderBusy || dirty || isSaving || isBusy || Boolean(batchBusy)} onClick={() => void rewriteScene(scene)} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                        {rewritingScenes.has(scene.sceneIndex) ? "다른 대본 받는 중..." : "다른 대본 (소액 비용)"}
                      </button>
                      {needsFirstGenerate && (
                        <button type="button" disabled={isBusy || reorderBusy || isSaving || Boolean(batchBusy)} onClick={() => void generateScene(scene, "mock")} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                          {isBusy ? "요청 중..." : "미리보기 생성 ($0.00)"}
                        </button>
                      )}
                      {scene.status === "ready" && (
                        <>
                          <a href={scene.videoUrl ?? "#"} download className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">다운로드</a>
                          {isMockScene(scene) ? (
                            <button type="button" disabled={isBusy || reorderBusy || isSaving || Boolean(batchBusy) || rewritingScenes.has(scene.sceneIndex)} onClick={() => void generateScene(scene, "real")} className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black">
                              진짜로 생성 (유료 {money(perSceneCostCents)})
                            </button>
                          ) : (
                            <button type="button" disabled={isBusy || reorderBusy || isSaving || Boolean(batchBusy) || rewritingScenes.has(scene.sceneIndex)} onClick={() => void generateScene(scene, "real")} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                              다시 만들기 (재과금 {money(perSceneCostCents)})
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              3. 최종 영상(MP4)은 PC에서 뽑습니다
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              나레이션·자막·배경음악을 합쳐 하나의 세로 영상으로 만드는 작업은 사진 쇼츠와
              같은 방식으로 PC에서 처리합니다(웹 서버에서 돌리기엔 너무 오래 걸려서요).
              모든 장면이 완성되면 아래에서 프로젝트 파일을 받아 실행하세요.
            </p>
            {!job?.narrationEnabled && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                내레이션을 끄고 만든 작업이라 자동 합치기를 지원하지 않아요(장면 길이를
                나레이션 실측 길이로 맞추는 방식이라서요). 장면별 클립은 위에서 개별
                다운로드할 수 있습니다.
              </p>
            )}
            {job?.narrationEnabled && !allScenesReady && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                아직 완성되지 않은 장면이 있어요 ({readyScenes.length}/{scenes.length}).
                모든 장면이 완성되면 다운로드 버튼이 나타납니다.
              </p>
            )}
            {projectUrl && (
              <>
                <a
                  href={projectUrl}
                  download="shorts-video-project.json"
                  className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                >
                  프로젝트 파일 내려받기
                </a>
                <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-100">
                  python .claude/skills/viral-shorts/build_shorts.py --project shorts-video-project.json
                </pre>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

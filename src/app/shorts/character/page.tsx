"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import { BGM_GROUPS, SFX_GROUPS, type BgmMood, type SfxCue } from "@/lib/audioCatalog";
import { AudioPreviewButton } from "@/components/AudioPreviewButton";
import type { SceneStyle } from "@/lib/characterShorts";
import { STYLE_OPTIONS, BGM_MOOD_BY_STYLE } from "@/lib/shortsUiLabels";

// "사진 1장으로 캐릭터 고정 + 내가 쓴 대본으로 장면 생성" 화면. AI 영상 쇼츠와 달리
// 실제 사진을 그대로 움직이지 않고, 기준 사진 1장의 생김새를 유지한 채 장면마다
// 완전히 새 이미지를 그린다(flux-kontext-pro). DB에 저장하지 않는다 — 사진 쇼츠와
// 같은 방식으로 이 화면에서 만든 결과를 프로젝트 파일로 내려받아
// build_shorts.py --project로 최종 렌더링한다.

const SCENE_MIN = 2;
const SCENE_MAX = 10;
const DEFAULT_SCENE_COUNT = 6;

const JPEG_QUALITY = 0.95;

type SceneStatus = "idle" | "generating" | "ready" | "failed";

type Scene = {
  narration: string;
  imagePrompt: string | null;
  sfx: SfxCue;
  imageUrl: string | null;
  status: SceneStatus;
  error: string | null;
  isMock: boolean;
};

const newScene = (): Scene => ({
  narration: "",
  imagePrompt: null,
  sfx: "none",
  imageUrl: null,
  status: "idle",
  error: null,
  isMock: false,
});

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// 탭을 실수로 닫거나 새로고침해도 입력한 대본·생성 결과를 잃지 않도록 브라우저에
// 자동 저장한다(DB는 안 쓰는 화면이라 이게 유일한 안전망). 계정과 무관하게 이
// 브라우저에만 남는 "임시 작업"이라 민감정보는 아니고, 저장 실패(프라이빗 모드 등)
// 해도 화면은 정상 동작해야 하므로 모두 조용히 무시한다.
const DRAFT_STORAGE_KEY = "character-shorts-draft-v1";

type Draft = {
  title: string;
  style: SceneStyle;
  bgmMood: BgmMood;
  previousSummary: string;
  referenceImageUrl: string;
  scenes: Scene[];
};

const loadDraft = (): Draft | null => {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
};

const saveDraft = (draft: Draft) => {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // 프라이빗 모드 등으로 저장이 막혀도 편집 자체는 계속돼야 한다.
  }
};

const clearDraft = () => {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // no-op
  }
};

const REAL_COST_PER_SCENE_CENTS = 4; // flux-kontext-pro, https://replicate.com/black-forest-labs/flux-kontext-pro

const SCENE_STATUS_LABEL: Record<SceneStatus, string> = {
  idle: "대기 중",
  generating: "생성 중...",
  ready: "완성",
  failed: "실패",
};

type LoadedImage = { source: CanvasImageSource; width: number; height: number; release: () => void };

const loadImage = async (file: File): Promise<LoadedImage> => {
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

// EXIF 회전을 반영해 원본 화질 그대로 blob으로 바꾼다(AI 영상 쇼츠와 같은 이유 —
// 기준 사진 화질이 곧 6장 전부의 결과 화질이라 줄이지 않는다).
const toOrientedBlob = async (file: File): Promise<{ blob: Blob; extension: string }> => {
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

export default function CharacterShortsPage() {
  const { user, loading: userLoading } = useSupabaseUser();

  const [referencePreview, setReferencePreview] = useState<string>("");
  const [referenceImageUrl, setReferenceImageUrl] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [title, setTitle] = useState("");
  const [style, setStyle] = useState<SceneStyle>("comic");
  const [bgmMood, setBgmMood] = useState<BgmMood>(BGM_MOOD_BY_STYLE.comic);
  // 시리즈(1~5편)를 만들 때 이전 편 줄거리를 넣어두면, 새 편 장면을 그릴 때 그 맥락을
  // 참고해서 소품·설정이 갑자기 달라지지 않게 한다(캐릭터 생김새는 기준 사진이 이미
  // 보장하므로, 이건 "이야기 흐름"만 신경 쓰면 된다).
  const [previousSummary, setPreviousSummary] = useState("");
  const [scenes, setScenes] = useState<Scene[]>(
    Array.from({ length: DEFAULT_SCENE_COUNT }, newScene),
  );

  const [errorMessage, setErrorMessage] = useState("");
  const [busyScenes, setBusyScenes] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState<"mock" | "real" | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);

  // 마운트 시 1회, 저장된 작업이 있으면 그대로 불러온다. localStorage는 브라우저
  // 전용 API라 SSR 중엔 못 쓰므로 useEffect 안에서만 읽을 수 있다 — 그래서
  // 여러 개의 setState를 한 번에 부르는 이 예외적인 초기화 패턴이 불가피하다.
  /* eslint-disable react-hooks/set-state-in-effect -- 마운트 시 1회 로컬 저장소 복원 */
  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      setTitle(draft.title);
      setStyle(draft.style);
      setBgmMood(draft.bgmMood);
      setPreviousSummary(draft.previousSummary);
      setReferenceImageUrl(draft.referenceImageUrl);
      // referenceImageUrl은 영구 Supabase URL이라 로컬 blob 없이 미리보기로 그대로 써도 된다.
      if (draft.referenceImageUrl) setReferencePreview(draft.referenceImageUrl);
      if (draft.scenes?.length) setScenes(draft.scenes);
    }
    setDraftRestored(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 입력할 때마다 자동 저장한다(탭을 실수로 닫아도 이어서 할 수 있게). 복원이
  // 끝나기 전에 저장하면 방금 불러온 내용을 빈 초기값으로 덮어써버리므로
  // draftRestored가 true가 된 뒤부터만 저장한다.
  useEffect(() => {
    if (!draftRestored) return;
    saveDraft({ title, style, bgmMood, previousSummary, referenceImageUrl, scenes });
  }, [draftRestored, title, style, bgmMood, previousSummary, referenceImageUrl, scenes]);

  useEffect(() => {
    return () => {
      if (referencePreview) URL.revokeObjectURL(referencePreview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 언마운트 시 1회만 정리
  }, []);

  const startOver = () => {
    if (!confirm("지금 작업 중인 내용을 지우고 새로 시작할까요? (이미 실제로 생성한 이미지 자체는 지워지지 않아요)")) {
      return;
    }
    clearDraft();
    setTitle("");
    setStyle("comic");
    setBgmMood(BGM_MOOD_BY_STYLE.comic);
    setPreviousSummary("");
    setReferenceImageUrl("");
    setReferencePreview("");
    setScenes(Array.from({ length: DEFAULT_SCENE_COUNT }, newScene));
    setErrorMessage("");
  };

  const authedFetch = async (input: string, init: RequestInit = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("로그인이 필요합니다.");
    return fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.access_token}` },
    });
  };

  const acceptReferenceFile = async (incoming: FileList | null) => {
    const file = incoming?.[0];
    if (!file || !file.type.startsWith("image/")) return;

    if (referencePreview) URL.revokeObjectURL(referencePreview);
    setReferencePreview(URL.createObjectURL(file));
    setReferenceImageUrl("");
    setErrorMessage("");
    setUploading(true);
    try {
      const { blob, extension } = await toOrientedBlob(file);
      const urlRes = await authedFetch("/api/shorts/video/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extensions: [extension] }),
      });
      const urlData = await urlRes.json();
      if (!urlRes.ok || !urlData.uploads?.[0]) {
        throw new Error(urlData.error ?? "업로드 준비에 실패했습니다.");
      }
      const { path, token, publicUrl } = urlData.uploads[0];
      const { error } = await supabase.storage
        .from("gallery")
        .uploadToSignedUrl(path, token, blob, { contentType: blob.type });
      if (error) throw new Error(`업로드 실패: ${error.message}`);
      setReferenceImageUrl(publicUrl);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "기준 사진 업로드에 실패했습니다.");
    } finally {
      setUploading(false);
    }
  };

  const updateScene = (index: number, patch: Partial<Scene>) => {
    setScenes((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addScene = () => {
    if (scenes.length >= SCENE_MAX) return;
    setScenes((prev) => [...prev, newScene()]);
  };

  const removeScene = (index: number) => {
    if (scenes.length <= SCENE_MIN) return;
    setScenes((prev) => prev.filter((_, i) => i !== index));
  };

  // 장면 하나를 생성한다. provider: "mock"(무료 미리보기, 기준 사진을 그대로 보여줌)
  // 또는 "real"(진짜 생성, flux-kontext-pro 실비용 $0.04/장).
  const generateScene = async (
    index: number,
    provider: "mock" | "real",
    options: { silent?: boolean } = {},
  ) => {
    const scene = scenes[index];
    if (!referenceImageUrl || !scene.narration.trim()) return;
    if (
      provider === "real" &&
      !options.silent &&
      !confirm(`장면 ${index + 1}을(를) 실제로 생성합니다 (예상 비용 ${money(REAL_COST_PER_SCENE_CENTS)}). 계속할까요?`)
    ) {
      return;
    }

    setBusyScenes((prev) => new Set(prev).add(index));
    updateScene(index, { status: "generating", error: null });
    try {
      const res = await authedFetch("/api/shorts/character/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referenceImageUrl,
          narration: scene.narration,
          style,
          sceneIndex: index + 1,
          totalScenes: scenes.length,
          provider,
          previousSummary,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "장면 생성에 실패했습니다.");
      updateScene(index, {
        imageUrl: data.imageUrl,
        imagePrompt: data.imagePrompt,
        sfx: data.sfx,
        status: "ready",
        isMock: data.provider === "mock",
        error: null,
      });
    } catch (err) {
      updateScene(index, { status: "failed", error: err instanceof Error ? err.message : "알 수 없는 오류" });
    } finally {
      setBusyScenes((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  };

  const batchGenerate = async (provider: "mock" | "real") => {
    if (!referenceImageUrl) return;
    const targets = scenes
      .map((s, i) => ({ scene: s, index: i }))
      .filter(({ scene }) => scene.narration.trim());
    if (targets.length === 0) return;

    if (provider === "real") {
      const estimate = money(targets.length * REAL_COST_PER_SCENE_CENTS);
      if (!confirm(`장면 ${targets.length}개를 실제로 생성합니다. 예상 총 비용 약 ${estimate}. 계속할까요?`)) {
        return;
      }
    }

    setBatchBusy(provider);
    try {
      for (const { index } of targets) {
        // 공급자 속도 제한을 지키려고 순차로 진행한다(AI 영상 쇼츠와 같은 이유).
        await generateScene(index, provider, { silent: true });
      }
    } finally {
      setBatchBusy(null);
    }
  };

  const readyScenes = scenes.filter((s) => s.status === "ready");
  const allReady = scenes.length > 0 && readyScenes.length === scenes.length;
  const canGenerate = Boolean(referenceImageUrl) && !uploading;

  const downloadProject = () => {
    const project = {
      thumbnailCopy: title.trim() || "캐릭터 쇼츠",
      bgmMood,
      scenes: scenes.map((scene, i) => ({
        index: i + 1,
        narration: scene.narration,
        imagePrompt: scene.imagePrompt ?? "",
        sfx: scene.sfx,
        kenBurns: i % 2 === 0 ? "in" : "out",
        imageUrl: scene.imageUrl,
      })),
      source: "web-character-shorts",
    };
    const json = JSON.stringify(project, null, 2);
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "shorts-character-project.json";
    a.click();
  };

  // 다음 편을 이어 만들 때 이번 편 이미지를 참고하거나 보관해둘 수 있게, 실제로
  // 생성된(미리보기가 아닌) 장면 이미지를 한 번에 전부 내려받는다. 브라우저가 여러
  // 다운로드를 한꺼번에 막는 경우가 있어 살짝 텀을 둔다.
  const downloadAllImages = async () => {
    const realScenes = scenes
      .map((scene, i) => ({ scene, i }))
      .filter(({ scene }) => scene.status === "ready" && !scene.isMock && scene.imageUrl);
    for (const { scene, i } of realScenes) {
      const a = document.createElement("a");
      a.href = scene.imageUrl!;
      a.download = `scene-${i + 1}.png`;
      a.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  const realReadyCount = scenes.filter((s) => s.status === "ready" && !s.isMock).length;

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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">AI 캐릭터 쇼츠는 로그인 후 이용할 수 있습니다.</p>
        <Link href="/login" className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black">로그인</Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">AI 캐릭터 쇼츠 (베타)</h1>
        <div className="flex items-center gap-3">
          <button type="button" onClick={startOver} className="text-sm font-medium text-zinc-500 hover:underline dark:text-zinc-400">새로 시작</button>
          <Link href="/shorts/video" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">AI 영상 쇼츠로 →</Link>
          <Link href="/shorts" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">사진 쇼츠로 →</Link>
        </div>
      </div>

      <div className="w-full max-w-2xl rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        베타 기능입니다. 기준 사진 1장의 생김새를 유지한 채, 직접 쓴 대본 한 줄마다 완전히 새로운
        장면 이미지를 그립니다(사진 속 인물/동물을 그대로 움직이는 게 아니라 새로 그려요).
        먼저 <strong>1차: 무료 미리보기</strong>로 대본·순서를 확인하고, 마음에 들면{" "}
        <strong>2차: 진짜 생성</strong>으로 실제 이미지를 만드세요. 입력 중인 내용은 이 브라우저에
        자동 저장되니, 탭을 닫아도 다시 들어오면 이어서 할 수 있어요.
      </div>

      <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">1. 캐릭터 기준 사진 1장을 올려주세요</p>
        <div
          onDragOver={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(false); void acceptReferenceFile(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${isDragging ? "border-black bg-zinc-100 dark:border-white dark:bg-zinc-900" : "border-zinc-300 dark:border-zinc-700"}`}
        >
          {referencePreview ? (
            // eslint-disable-next-line @next/next/no-img-element -- 로컬 objectURL 미리보기
            <img src={referencePreview} alt="기준 사진" className="h-40 w-28 rounded-lg object-cover" />
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">여기로 사진을 끌어다 놓거나 눌러서 선택하세요</p>
          )}
          {uploading && <p className="text-xs text-zinc-400">업로드 중...</p>}
          {referenceImageUrl && !uploading && <p className="text-xs text-emerald-600 dark:text-emerald-400">업로드 완료</p>}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(e) => void acceptReferenceFile(e.target.files)} />
        </div>

        <div className="grid grid-cols-1 gap-2 border-t border-zinc-200 pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 sm:grid-cols-2">
          <label className="flex items-center gap-2">
            제목
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 흑돼지 제주 모험기 1편"
              className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
          </label>
          <label className="flex items-center gap-2">
            스타일
            <select
              value={style}
              onChange={(e) => {
                const next = e.target.value as SceneStyle;
                setStyle(next);
                setBgmMood(BGM_MOOD_BY_STYLE[next]);
              }}
              className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            >
              {STYLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            배경음악
            <select value={bgmMood} onChange={(e) => setBgmMood(e.target.value as BgmMood)} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
              {BGM_GROUPS.map(({ group, items }) => (
                <optgroup key={group} label={group}>
                  {items.map((entry) => <option key={entry.mood} value={entry.mood}>{entry.label}</option>)}
                </optgroup>
              ))}
            </select>
            <AudioPreviewButton kind="bgm" name={bgmMood} />
          </label>
        </div>

        <label className="flex flex-col gap-1 border-t border-zinc-200 pt-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          이전 편 줄거리 (선택 — 시리즈로 이어 만들 때, 1편에서 있었던 일을 간단히 적어두면
          이번 편 장면들이 앞뒤가 안 맞게 그려지는 걸 줄여줘요)
          <textarea
            value={previousSummary}
            onChange={(e) => setPreviousSummary(e.target.value)}
            rows={2}
            placeholder="예: 1편에서 꿀돈이가 해변에서 귤 모자를 잃어버렸다가 다시 찾았다."
            className="w-full resize-y rounded border border-zinc-300 bg-transparent px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
          />
        </label>
        {errorMessage && <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>}
      </section>

      <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">2. 장면마다 대본을 쓰고 이미지를 만드세요</p>
          <span className="text-xs text-zinc-400">{scenes.length}개 장면 (총 약 {scenes.length * 5}초)</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={batchBusy !== null || !canGenerate}
            onClick={() => void batchGenerate("mock")}
            className="rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {batchBusy === "mock" ? "미리보기 생성 중..." : "1차: 전체 무료 미리보기 ($0.00)"}
          </button>
          <button
            type="button"
            disabled={batchBusy !== null || !canGenerate}
            onClick={() => void batchGenerate("real")}
            className="rounded-full bg-black px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {batchBusy === "real" ? "실제 생성 중..." : `2차: 전체 진짜 생성 (${money(scenes.length * REAL_COST_PER_SCENE_CENTS)})`}
          </button>
        </div>
        {!referenceImageUrl && <p className="text-xs text-zinc-400 dark:text-zinc-500">먼저 위에서 기준 사진을 올려주세요.</p>}

        <ol className="flex flex-col gap-3">
          {scenes.map((scene, index) => {
            const isBusy = busyScenes.has(index);
            return (
              <li key={index} className="flex gap-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="flex shrink-0 flex-col items-center gap-1">
                  {scene.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 생성 결과/기준 사진 미리보기
                    <img src={scene.imageUrl} alt={`장면 ${index + 1}`} className="h-32 w-20 rounded object-cover" />
                  ) : (
                    <div className="flex h-32 w-20 items-center justify-center rounded bg-zinc-100 text-[10px] text-zinc-400 dark:bg-zinc-900">
                      장면 {index + 1}
                    </div>
                  )}
                  {scenes.length > SCENE_MIN && (
                    <button type="button" onClick={() => removeScene(index)} className="rounded border border-zinc-300 px-1.5 text-xs leading-5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900" title="장면 삭제">
                      삭제
                    </button>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-400">
                      장면 {index + 1} · {SCENE_STATUS_LABEL[scene.status]}
                      {scene.status === "ready" && (scene.isMock ? " (미리보기)" : " (실제 생성)")}
                    </span>
                  </div>
                  <textarea
                    value={scene.narration}
                    onChange={(e) => updateScene(index, { narration: e.target.value })}
                    rows={2}
                    placeholder="이 장면의 대본을 직접 써주세요"
                    className="mt-0.5 w-full resize-y rounded border border-zinc-300 bg-transparent px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                  />
                  <div className="mt-1 flex items-center gap-1.5">
                    <label className="text-xs text-zinc-400">효과음</label>
                    <select
                      value={scene.sfx}
                      onChange={(e) => updateScene(index, { sfx: e.target.value as SfxCue })}
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
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={isBusy || !canGenerate || !scene.narration.trim()}
                      onClick={() => void generateScene(index, "mock")}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      {isBusy ? "요청 중..." : "미리보기 ($0.00)"}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy || !canGenerate || !scene.narration.trim()}
                      onClick={() => void generateScene(index, "real")}
                      className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
                    >
                      {scene.status === "ready" && !scene.isMock
                        ? `다시 만들기 (재과금 ${money(REAL_COST_PER_SCENE_CENTS)})`
                        : `진짜로 생성 (유료 ${money(REAL_COST_PER_SCENE_CENTS)})`}
                    </button>
                    {scene.status === "ready" && !scene.isMock && scene.imageUrl && (
                      <a
                        href={scene.imageUrl}
                        download={`scene-${index + 1}.png`}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      >
                        이미지 다운로드
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap gap-2">
          {scenes.length < SCENE_MAX && (
            <button type="button" onClick={addScene} className="self-start rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              + 장면 추가
            </button>
          )}
          {realReadyCount > 0 && (
            <button
              type="button"
              onClick={() => void downloadAllImages()}
              className="self-start rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              title="다음 편을 만들 때 참고하거나 보관해두기 좋아요"
            >
              생성된 이미지 {realReadyCount}장 전체 다운로드
            </button>
          )}
        </div>
      </section>

      <section className="flex w-full max-w-2xl flex-col gap-2 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">3. 최종 영상(MP4)은 PC에서 뽑습니다</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          나레이션·자막·배경음악을 합쳐 하나의 세로 영상으로 만드는 작업은 다른 쇼츠 기능과
          같은 방식으로 PC에서 처리합니다. 모든 장면이 완성되면 아래에서 프로젝트 파일을 받아 실행하세요.
        </p>
        {!allReady && scenes.length > 0 && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            아직 완성되지 않은 장면이 있어요 ({readyScenes.length}/{scenes.length}).
          </p>
        )}
        {allReady && (
          <>
            <button
              type="button"
              onClick={downloadProject}
              className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              프로젝트 파일 내려받기
            </button>
            <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-100">
              python .claude/skills/viral-shorts/build_shorts.py --project shorts-character-project.json
            </pre>
          </>
        )}
      </section>
    </div>
  );
}

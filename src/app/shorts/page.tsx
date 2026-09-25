"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import { downscaleToDataUrl } from "@/lib/downscaleImage";
import { BGM_GROUPS, SFX_GROUPS } from "@/lib/audioCatalog";
import { AudioHelp } from "@/components/AudioHelp";
import { AudioPreviewButton } from "@/components/AudioPreviewButton";

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
  requestedSceneCount?: number | null;
};

// 장면 수 고르기의 최소값. 서버(shortsFromImages.ts의 MIN_SCENES)와 같아야 한다 —
// 그 파일은 AI SDK를 불러와서 화면 코드에서 직접 import하지 않는다.
const PICKABLE_MIN_SCENES = 5;
// 장면당 시간(초). PC 합성기는 대사가 짧아도 장면을 최소 2.4초 보여주고(build_shorts.py
// MIN_SCENE_SECONDS), 음성은 공백·부호 빼고 초당 약 7자를 읽는다.
const SCENE_MIN_SECONDS = 2.4;
// 장면당 목표 시간(shortsFromImages.ts의 SCENE_TARGET_*와 같아야 한다).
const SCENE_TARGET_MIN_SECONDS = 3.0;
const SCENE_TARGET_MAX_SECONDS = 4.2;
const TTS_CHARS_PER_SECOND = 7;

const MIN_IMAGES = 5;
const MAX_IMAGES = 15;

// 장면을 지우다 보면 한 장짜리가 남을 수 있는데, 그건 영상이라기보다 정지 이미지다.
// 더 줄이고 싶으면 사진을 줄여서 다시 만드는 편이 결과가 낫다.
const MIN_SCENES = 2;

const STEP_LABEL: Record<Step, string> = {
  idle: "",
  uploading: "이미지 업로드 중...",
  analyzing: "AI가 이미지를 보고 대본 쓰는 중... (사진이 많으면 1~2분, 창을 닫지 마세요)",
  composing: "썸네일 만드는 중...",
  done: "완성!",
  error: "",
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
        "AI가 5분 안에 대본을 끝내지 못했어요. 장면 수를 줄이거나 사진을 몇 장 빼고 다시 시도해 주세요.",
      );
    }
    throw new Error(`${fallback} (서버 응답 코드 ${response.status})`);
  }
};

// 썸네일을 만든 재료(문구 + 배경 사진). 이게 바뀌면 썸네일도 다시 만들어야 한다.
const thumbnailKey = (title: string, backgroundUrl: string) => `${title}\n${backgroundUrl}`;

export default function ShortsPage() {
  const { user, loading: userLoading } = useSupabaseUser();

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [step, setStep] = useState<Step>("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  // "auto"면 AI가 이야기에 맞는 사진만 골라 장면 수를 정한다. 숫자면 정확히 그만큼.
  const [sceneChoice, setSceneChoice] = useState<"auto" | number>("auto");
  const [errorMessage, setErrorMessage] = useState("");
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  // 지금 보이는 썸네일이 어떤 문구·사진으로 만들어졌는지. 편집한 내용과 다르면
  // "다시 만들기" 버튼을 눈에 띄게 켠다.
  const [thumbnailBuiltFrom, setThumbnailBuiltFrom] = useState("");
  const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const [thumbnailError, setThumbnailError] = useState("");
  // 올린 순서 그대로의 저장소 주소. 장면이 어느 사진을 쓰는지 되짚고, 다른 사진으로
  // 바꿔 끼우는 데 쓴다.
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 미리보기·다운로드용 objectURL 정리 (안 하면 메모리에 계속 남는다)
  useEffect(() => {
    return () => {
      previews.forEach((url) => URL.revokeObjectURL(url));
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 언마운트 시 1회만 정리
  }, []);

  // 장면의 사진을 바꾸면 내려받을 파일도 따라 바뀌어야 한다. 생성할 때 한 번만
  // 만들어두면 편집한 내용이 빠진 채로 받아가게 된다. 대본은 몇 KB뿐이라 데이터
  // URL로 바로 만든다 — objectURL과 달리 나중에 해제할 것이 남지 않는다.
  const projectUrl = useMemo(() => {
    if (!storyboard) return "";
    const json = JSON.stringify({ ...storyboard, source: "web-upload" }, null, 2);
    return `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  }, [storyboard]);

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

  const photoNumberOf = (url: string) => uploadedUrls.indexOf(url) + 1;

  // 읽히는 글자만 센다. 대본 리듬(짧은 줄 8자 이하, 긴 줄 25자 이하)을 눈으로
  // 맞출 수 있게 화면에 그대로 보여준다.
  const inkLength = (text: string) =>
    text.replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "").length;

  const changeNarration = (sceneIndex: number, text: string) => {
    setStoryboard((prev) =>
      prev
        ? {
            ...prev,
            scenes: prev.scenes.map((scene, i) =>
              i === sceneIndex ? { ...scene, narration: text } : scene,
            ),
          }
        : prev,
    );
  };

  const changeThumbnailCopy = (text: string) => {
    setStoryboard((prev) => (prev ? { ...prev, thumbnailCopy: text } : prev));
  };

  const changeSfx = (sceneIndex: number, cue: string) => {
    setStoryboard((prev) =>
      prev
        ? {
            ...prev,
            scenes: prev.scenes.map((scene, i) =>
              i === sceneIndex ? { ...scene, sfx: cue } : scene,
            ),
          }
        : prev,
    );
  };

  const changeBgmMood = (mood: string) => {
    setStoryboard((prev) => (prev ? { ...prev, bgmMood: mood } : prev));
  };

  // 장면을 뺀다. scene.index는 손대지 않는다 — 그 번호가 PC에서 내려받는 이미지
  // 파일 이름(scene_3.png)이라, 다시 매기면 남은 장면들이 남의 그림을 가져간다.
  // 화면에 보이는 번호는 어차피 순서대로 다시 그려진다.
  const removeScene = (sceneIndex: number) => {
    setStoryboard((prev) => {
      if (!prev || prev.scenes.length <= MIN_SCENES) return prev;
      return { ...prev, scenes: prev.scenes.filter((_, i) => i !== sceneIndex) };
    });
  };

  // 장면이 쓸 사진을 바꾼다. 고른 사진을 이미 다른 장면이 쓰고 있으면 두 장면의
  // 사진을 맞바꾼다. 한쪽으로 밀어내면 같은 사진이 두 장면에 겹치거나, 쓰던 사진이
  // 아무 데도 안 남게 된다.
  const changeSceneImage = (sceneIndex: number, photoNumber: number) => {
    setStoryboard((prev) => {
      if (!prev) return prev;
      const wanted = uploadedUrls[photoNumber - 1];
      const current = prev.scenes[sceneIndex]?.imageUrl;
      if (!wanted || !current || wanted === current) return prev;
      return {
        ...prev,
        scenes: prev.scenes.map((scene, i) => {
          if (i === sceneIndex) return { ...scene, imageUrl: wanted };
          if (scene.imageUrl === wanted) return { ...scene, imageUrl: current };
          return scene;
        }),
      };
    });
  };

  // 썸네일은 첫 장면 사진으로 만든다. 문구나 첫 장면을 바꿨으면 다시 만들어야 맞는다.
  // 서버에서 글자만 얹는 작업이라 AI 비용이 들지 않는다.
  const rebuildThumbnail = async () => {
    if (!storyboard || thumbnailBusy) return;
    const title = storyboard.thumbnailCopy.trim();
    if (!title) {
      setThumbnailError("썸네일 문구를 먼저 적어 주세요.");
      return;
    }
    const backgroundUrl = storyboard.scenes[0].imageUrl;
    setThumbnailBusy(true);
    setThumbnailError("");
    try {
      const response = await authedFetch("/api/thumbnail/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backgroundUrl, title }),
      });
      if (!response.ok) {
        const result = await readJson<{ error?: string }>(
          response,
          "썸네일을 다시 만들지 못했어요.",
        );
        throw new Error(result.error ?? "썸네일을 다시 만들지 못했어요.");
      }
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setThumbnailUrl(URL.createObjectURL(await response.blob()));
      setThumbnailBuiltFrom(thumbnailKey(title, backgroundUrl));
    } catch (err) {
      // 썸네일은 곁다리라, 실패해도 대본과 영상 제작에는 지장이 없다.
      setThumbnailError(
        err instanceof Error ? err.message : "썸네일을 다시 만들지 못했어요.",
      );
    } finally {
      setThumbnailBusy(false);
    }
  };

  const handleGenerate = async () => {
    setErrorMessage("");
    setUploadedCount(0);
    setStoryboard(null);
    setThumbnailUrl("");
    setThumbnailBuiltFrom("");
    setThumbnailError("");

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
        body: JSON.stringify({
          imageUrls,
          // 사진을 지워서 고른 수보다 적어졌으면 남은 사진 수로 맞춘다.
          sceneCount:
            sceneChoice === "auto" ? undefined : Math.min(sceneChoice, imageUrls.length),
        }),
      });
      const board = await readJson<Storyboard & { error?: string }>(
        analyzeResponse,
        "시나리오 생성에 실패했습니다.",
      );
      if (!analyzeResponse.ok) {
        throw new Error(board.error ?? "시나리오 생성에 실패했습니다.");
      }
      setUploadedUrls(imageUrls);
      setStoryboard(board);

      setStep("composing");
      // 첫 장면 사진으로 만든다. 올린 순서의 첫 사진은 AI가 빼거나 뒤로 보냈을 수 있다.
      const backgroundUrl = board.scenes[0]?.imageUrl ?? imageUrls[0];
      const composeResponse = await authedFetch("/api/thumbnail/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backgroundUrl, title: board.thumbnailCopy }),
      });
      if (composeResponse.ok) {
        setThumbnailUrl(URL.createObjectURL(await composeResponse.blob()));
        setThumbnailBuiltFrom(thumbnailKey(board.thumbnailCopy.trim(), backgroundUrl));
      }

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
      <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-sm text-zinc-500">로그인 상태 확인 중...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-4 dark:bg-black">
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
  const thumbnailOutdated = Boolean(
    storyboard &&
      thumbnailKey(storyboard.thumbnailCopy.trim(), storyboard.scenes[0]?.imageUrl ?? "") !==
        thumbnailBuiltFrom,
  );
  const canGenerate = files.length >= MIN_IMAGES && !busy;
  const busyLabel =
    step === "uploading"
      ? `이미지 업로드 중... (${Math.min(uploadedCount + 1, files.length)}/${files.length})`
      : STEP_LABEL[step];

  return (
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">
          이미지로 쇼츠 만들기
        </h1>
        <div className="flex items-center gap-3">
          <Link
            href="/shorts/video"
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            AI 영상 쇼츠(베타) →
          </Link>
          <Link
            href="/thumbnail"
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            썸네일만 만들기 →
          </Link>
        </div>
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

        {files.length >= PICKABLE_MIN_SCENES && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            장면 수
            <select
              value={
                sceneChoice === "auto" ? "auto" : String(Math.min(sceneChoice, files.length))
              }
              onChange={(event) =>
                setSceneChoice(
                  event.target.value === "auto" ? "auto" : Number(event.target.value),
                )
              }
              className="rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
            >
              <option value="auto">AI가 정하기 (이야기에 맞는 사진만 골라요)</option>
              {Array.from(
                { length: files.length - PICKABLE_MIN_SCENES + 1 },
                (_, i) => PICKABLE_MIN_SCENES + i,
              ).map((n) => (
                <option key={n} value={n}>
                  {n}장면{n === files.length ? " (사진 전부 사용)" : ` (사진 ${files.length}장 중 ${n}장)`}
                </option>
              ))}
            </select>
            <span className="text-xs text-zinc-400">
              {sceneChoice === "auto"
                ? "보통 6장면, 약 20~30초"
                : `약 ${Math.round(Math.min(sceneChoice, files.length) * SCENE_TARGET_MIN_SECONDS)}~${Math.round(
                    Math.min(sceneChoice, files.length) * SCENE_TARGET_MAX_SECONDS,
                  )}초`}
            </span>
          </label>
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
            {/* 줄바꿈을 넣으면 JSX가 그 사이 공백을 지워서 "골라6개"로 붙는다 */}
            올린 {files.length}장 중 {storyboard.scenes.length}장을 골라{" "}
            {storyboard.scenes.length}개 장면으로 만들었어요. 예상 길이 약{" "}
            {Math.round(
              storyboard.scenes.reduce(
                (sum, scene) =>
                  sum +
                  Math.max(inkLength(scene.narration) / TTS_CHARS_PER_SECOND, SCENE_MIN_SECONDS),
                0,
              ),
            )}
            초(대사가 짧은 장면은 사진이 {SCENE_MIN_SECONDS}초 머물러요).
            {storyboard.requestedSceneCount &&
            storyboard.scenes.length < storyboard.requestedSceneCount
              ? ` 요청한 ${storyboard.requestedSceneCount}장면 중 ${storyboard.scenes.length}장면만 쓸 수 있었어요(AI가 같은 사진을 두 번 고른 장면은 뺐어요). 다시 생성하면 맞춰질 수 있어요.`
              : files.length > storyboard.scenes.length &&
                " 빠진 사진은 이야기에 안 맞아 뺀 것이고, 다음 영상에 쓰시면 됩니다."}
          </p>

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="sm:w-44">
              {thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- blob objectURL
                <img
                  src={thumbnailUrl}
                  alt="썸네일 미리보기"
                  className={`w-full rounded-xl border border-zinc-200 dark:border-zinc-800 ${
                    thumbnailBusy ? "opacity-50" : ""
                  }`}
                />
              ) : (
                <div className="flex aspect-[9/16] w-full items-center justify-center rounded-xl border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-700">
                  썸네일 없음
                </div>
              )}
              <label className="mt-2 block text-xs text-zinc-500 dark:text-zinc-400">
                썸네일 문구
                <input
                  value={storyboard.thumbnailCopy}
                  onChange={(event) => changeThumbnailCopy(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void rebuildThumbnail();
                    }
                  }}
                  maxLength={40}
                  placeholder="예: 해녀가 물고기를 놔줬다고?"
                  className="mt-1 block w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm font-medium text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                />
              </label>
              <button
                type="button"
                onClick={() => void rebuildThumbnail()}
                disabled={thumbnailBusy}
                className={`mt-2 block w-full rounded-full px-3 py-1.5 text-center text-xs font-semibold disabled:opacity-50 ${
                  thumbnailOutdated
                    ? "bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                    : "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                }`}
              >
                {thumbnailBusy ? "만드는 중..." : "썸네일 다시 만들기"}
              </button>
              {thumbnailOutdated && !thumbnailBusy && (
                <p className="mt-1 text-center text-[11px] text-amber-600 dark:text-amber-400">
                  문구나 첫 장면이 바뀌었어요. 다시 만들어야 반영돼요.
                </p>
              )}
              {thumbnailError && (
                <p className="mt-1 text-center text-[11px] text-red-600">{thumbnailError}</p>
              )}
              {thumbnailUrl && (
                <a
                  href={thumbnailUrl}
                  download="thumbnail.png"
                  className="mt-2 block rounded-full border border-zinc-300 px-3 py-1.5 text-center text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  썸네일 저장
                </a>
              )}
            </div>

            <div className="flex-1">
              <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="shrink-0">배경음악</span>
                <select
                  value={storyboard.bgmMood}
                  onChange={(event) => changeBgmMood(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                >
                  {BGM_GROUPS.map(({ group, items }) => (
                    <optgroup key={group} label={group}>
                      {items.map((entry) => (
                        <option key={entry.mood} value={entry.mood}>
                          {entry.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <AudioPreviewButton kind="bgm" name={storyboard.bgmMood} />
              </div>
              <ol className="flex flex-col gap-2">
                {storyboard.scenes.map((scene, sceneIndex) => {
                  const photoNumber = photoNumberOf(scene.imageUrl);
                  return (
                    <li
                      key={scene.index}
                      className="flex gap-2 rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-800"
                    >
                      {previews[photoNumber - 1] && (
                        // eslint-disable-next-line @next/next/no-img-element -- blob objectURL
                        <img
                          src={previews[photoNumber - 1]}
                          alt={`장면 ${scene.index} 사진`}
                          className="h-20 w-12 shrink-0 rounded object-cover"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-zinc-400">
                            장면 {sceneIndex + 1} · 줌 {scene.kenBurns}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeScene(sceneIndex)}
                            disabled={storyboard.scenes.length <= MIN_SCENES}
                            title={
                              storyboard.scenes.length <= MIN_SCENES
                                ? `장면은 ${MIN_SCENES}개보다 적을 수 없어요`
                                : "이 장면 빼기"
                            }
                            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                          >
                            빼기
                          </button>
                        </div>
                        <textarea
                          value={scene.narration}
                          onChange={(event) =>
                            changeNarration(sceneIndex, event.target.value)
                          }
                          rows={2}
                          className="mt-0.5 w-full resize-y rounded border border-zinc-300 bg-transparent px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                        />
                        <span
                          className={`text-xs ${
                            inkLength(scene.narration) > 25
                              ? "text-amber-600 dark:text-amber-500"
                              : "text-zinc-400"
                          }`}
                        >
                          {inkLength(scene.narration)}자
                          {inkLength(scene.narration) > 25 && " · 25자 넘으면 길어요"}
                          {inkLength(scene.narration) <= 8 && " · 짧게 툭 (좋아요)"}
                        </span>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <select
                            value={photoNumber}
                            onChange={(event) =>
                              changeSceneImage(sceneIndex, Number(event.target.value))
                            }
                            className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                          >
                            {uploadedUrls.map((_, i) => (
                              <option key={i} value={i + 1}>
                                사진 {i + 1}
                                {i + 1 === photoNumber ? " (현재)" : ""}
                              </option>
                            ))}
                          </select>
                          <select
                            value={scene.sfx}
                            onChange={(event) =>
                              changeSfx(sceneIndex, event.target.value)
                            }
                            className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                          >
                            {SFX_GROUPS.map(({ group, items }) => (
                              <optgroup key={group} label={group}>
                                {items.map((entry) => (
                                  <option key={entry.cue} value={entry.cue}>
                                    {entry.label}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <AudioPreviewButton kind="sfx" name={scene.sfx} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                영상 뽑기 전에 여기서 다 고칠 수 있어요. 대본은 직접 쓰고, 사진·효과음은
                골라서 바꾸고, 필요 없는 장면은 &ldquo;빼기&rdquo;로 지우면 됩니다. 이미
                다른 장면이 쓰는 사진을 고르면 둘이 자리를 맞바꿉니다.
                {storyboard.scenes.length <= MIN_SCENES &&
                  ` 지금은 ${MIN_SCENES}개라 더 뺄 수 없어요.`}
              </p>
              <AudioHelp />
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

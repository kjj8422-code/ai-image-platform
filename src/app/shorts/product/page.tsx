"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { readJson } from "@/lib/readJson";
import { useSupabaseUser } from "@/lib/useSupabaseUser";
import { downscaleToDataUrl } from "@/lib/downscaleImage";
import { BGM_GROUPS, SFX_GROUPS } from "@/lib/audioCatalog";
import { AudioPreviewButton } from "@/components/AudioPreviewButton";
import { AudioHelp } from "@/components/AudioHelp";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_PRODUCT_IMAGES,
  MAX_REVIEWS_CHARS,
  MIN_PRODUCT_SCENES,
  MIN_REVIEWS_CHARS,
  findFakeExperienceClaims,
  isQuoteFromReviews,
} from "@/lib/productShortsRules";

// 쿠팡 꿀템 쇼츠: 상품 사진 + 설명 + 실제 구매 후기 -> 대본·후기 카드·업로드 문구.
// 영상(MP4)은 다른 쇼츠처럼 PC에서 build_shorts.py가 만든다.

type Scene = {
  index: number;
  imageIndex: number;
  imageUrl: string;
  narration: string;
  reviewQuote: string;
  reviewRating: number;
  sfx: string;
  kenBurns: "in" | "out";
};

type Script = {
  hooks: { type: string; text: string }[];
  thumbnailCopy: string;
  bgmMood: string;
  scenes: Scene[];
  reviewInsights: { pros: string[]; cons: string[] };
  youtubeTitle: string;
  hashtags: string[];
  description: string;
  pinnedComment: string;
  warnings: string[];
};

type Step = "idle" | "uploading" | "writing" | "done";

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm text-zinc-800 outline-none focus:border-black dark:border-zinc-700 dark:text-zinc-200 dark:focus:border-white";

const CopyBox = ({ label, value }: { label: string; value: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 권한이 없으면 사용자가 직접 선택해 복사할 수 있다(아래 textarea).
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-full border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {copied ? "✓ 복사됨" : "복사"}
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={Math.min(8, value.split("\n").length + 1)}
        className="w-full resize-y rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      />
    </div>
  );
};

export default function ProductShortsPage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [productName, setProductName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [reviews, setReviews] = useState("");
  const [link, setLink] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [uploaded, setUploaded] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [script, setScript] = useState<Script | null>(null);
  // 대본을 만들 때 쓴 후기. 사용자가 입력 칸을 고쳐도 인용 검사는 AI가 본 원문 기준이다.
  const [reviewsUsed, setReviewsUsed] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = step === "uploading" || step === "writing";

  const acceptFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const images = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const next = [...files, ...images].slice(0, MAX_PRODUCT_IMAGES);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
  };

  const removeAt = (target: number) => {
    const next = files.filter((_, i) => i !== target);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
  };

  const authedFetch = async (input: string, init: RequestInit = {}) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("로그인이 필요합니다.");
    return fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.access_token}` },
    });
  };

  const handleGenerate = async () => {
    setErrorMessage("");
    setScript(null);
    try {
      setStep("uploading");
      const imageUrls: string[] = [];
      for (const [i, file] of files.entries()) {
        setUploaded(i);
        const response = await authedFetch("/api/shorts/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageDataUrls: [await downscaleToDataUrl(file)] }),
        });
        const result = await readJson(response);
        if (!response.ok || !Array.isArray(result?.imageUrls)) {
          throw new Error(result?.error ?? "사진 업로드에 실패했습니다.");
        }
        imageUrls.push(...result.imageUrls);
      }
      setUploaded(files.length);

      setStep("writing");
      const response = await authedFetch("/api/shorts/product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls, productName, price, description, reviews, link }),
      });
      const result = await readJson(response);
      if (!response.ok) throw new Error(result?.error ?? "대본 생성에 실패했습니다.");
      setUploadedUrls(imageUrls);
      setReviewsUsed(reviews);
      setScript(result as Script);
      setStep("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
      setStep("idle");
    }
  };

  const updateScene = (i: number, patch: Partial<Scene>) =>
    setScript((prev) =>
      prev ? { ...prev, scenes: prev.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : prev,
    );

  const removeScene = (i: number) =>
    setScript((prev) =>
      prev && prev.scenes.length > MIN_PRODUCT_SCENES
        ? { ...prev, scenes: prev.scenes.filter((_, j) => j !== i) }
        : prev,
    );

  // PC의 build_shorts.py가 읽는 프로젝트 파일. 파일 이름이 shorts-project로 시작해야
  // 쇼츠-자동만들기.bat이 다운로드 폴더에서 알아서 집어 간다. imageFit=contain은
  // 정사각형 상품 사진이 잘리지 않게 통째로 보여 주라는 뜻이다.
  const projectUrl = useMemo(() => {
    if (!script) return "";
    const project = {
      source: "product",
      thumbnailCopy: script.thumbnailCopy,
      bgmMood: script.bgmMood,
      imageFit: "contain",
      scenes: script.scenes.map((s, i) => ({
        index: i + 1,
        narration: s.narration,
        sfx: s.sfx,
        kenBurns: s.kenBurns,
        imageUrl: s.imageUrl,
        reviewQuote: s.reviewQuote,
        reviewRating: s.reviewRating,
      })),
    };
    return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(project, null, 2))}`;
  }, [script]);

  const liveClaims = useMemo(
    () => (script ? findFakeExperienceClaims(script.scenes.map((s) => s.narration)) : []),
    [script],
  );

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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">쿠팡 꿀템 쇼츠는 로그인 후 이용할 수 있습니다.</p>
        <Link href="/login" className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-black">
          로그인
        </Link>
      </div>
    );
  }

  const canGenerate = !busy && files.length > 0 && reviews.trim().length >= MIN_REVIEWS_CHARS;

  return (
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-4 py-10 dark:bg-black">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold text-black dark:text-white">쿠팡 꿀템 쇼츠</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          상품 사진 + 설명 + <b>진짜 구매 후기</b>로 20~30초 쇼핑 쇼츠 대본을 만들어요. 후기는 화면에
          ⭐ 후기 카드로 그대로 나와요.
        </p>
      </div>

      {/* 1단계: 입력 */}
      <section className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">1. 상품 사진 (1~{MAX_PRODUCT_IMAGES}장)</p>
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e: DragEvent<HTMLDivElement>) => e.preventDefault()}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            acceptFiles(e.dataTransfer.files);
          }}
          className="cursor-pointer rounded-xl border-2 border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 hover:border-zinc-500 dark:border-zinc-700"
        >
          쿠팡 상품 사진·상세 이미지를 끌어다 놓거나 눌러서 선택하세요
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => acceptFiles(e.target.files)}
          />
        </div>
        {previews.length > 0 && (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
            {previews.map((url, i) => (
              <div key={url} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 objectURL 미리보기 */}
                <img src={url} alt={`상품 사진 ${i + 1}`} className="aspect-square w-full rounded-lg bg-white object-contain" />
                <span className="absolute left-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] text-white">{i + 1}</span>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[10px] text-white"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">2. 상품 정보</p>
        <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
          <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="상품명 (예: 진공 보온 텀블러 500ml)" className={inputClass} />
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="가격 (예: 12,900원)" className={inputClass} />
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_CHARS))}
          rows={3}
          placeholder="상품 설명 (상세페이지의 특징·용량·소재 등을 붙여 넣으세요)"
          className={inputClass}
        />

        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          3. 실제 구매 후기 <span className="text-red-500">*필수</span>
        </p>
        <textarea
          value={reviews}
          onChange={(e) => setReviews(e.target.value.slice(0, MAX_REVIEWS_CHARS))}
          rows={7}
          placeholder={"쿠팡 상품 페이지의 리뷰를 여러 개 드래그해서 복사 → 여기에 붙여 넣으세요.\n좋은 후기 + 아쉬운 후기를 섞어 넣으면 더 믿음 가는 영상이 나와요."}
          className={inputClass}
        />
        <p className="-mt-2 text-xs text-zinc-400">
          {reviews.length.toLocaleString()} / {MAX_REVIEWS_CHARS.toLocaleString()}자 · 화면 카드에는 후기 문장만 나오고
          작성자 이름은 나오지 않아요.
        </p>

        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">4. 쿠팡 파트너스 링크 (선택)</p>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://link.coupang.com/a/..." className={inputClass} />

        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={!canGenerate}
          className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {step === "uploading"
            ? `사진 올리는 중... (${uploaded}/${files.length})`
            : step === "writing"
              ? "AI가 후기 읽고 대본 쓰는 중... (30초 정도)"
              : "대본 만들기"}
        </button>
        <p className="-mt-2 text-xs text-zinc-400">누를 때마다 AI(Claude)를 1번 호출해요 — 소액의 API 비용이 나가요.</p>
        {errorMessage && <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>}
      </section>

      {/* 2단계: 결과 */}
      {script && (
        <section className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          {(script.warnings.length > 0 || liveClaims.length > 0) && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {script.warnings.map((w) => (
                <p key={w}>⚠️ {w}</p>
              ))}
              {liveClaims.length > 0 && (
                <p>
                  ⚠️ 진행자가 직접 써 본 것처럼 들려요. &ldquo;구매자들이 ~래요&rdquo;처럼 바꿔 주세요:{" "}
                  {liveClaims.map((c) => `"${c}"`).join(", ")}
                </p>
              )}
            </div>
          )}

          <div>
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">첫 1초 문장 고르기</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {script.hooks.map((hook) => (
                <button
                  key={hook.text}
                  type="button"
                  onClick={() => setScript({ ...script, thumbnailCopy: hook.text })}
                  className={`rounded-lg border px-3 py-2 text-left text-sm ${
                    script.thumbnailCopy === hook.text
                      ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
                      : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  }`}
                >
                  <span className="mr-2 text-[10px] opacity-60">{hook.type}</span>
                  {hook.text}
                </button>
              ))}
            </div>
            <input
              value={script.thumbnailCopy}
              onChange={(e) => setScript({ ...script, thumbnailCopy: e.target.value })}
              className={`${inputClass} mt-2`}
            />
          </div>

          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg bg-emerald-50 p-3 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <p className="font-medium">후기에서 반복되는 장점</p>
              {script.reviewInsights.pros.map((p) => (
                <p key={p}>👍 {p}</p>
              ))}
            </div>
            <div className="rounded-lg bg-zinc-100 p-3 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              <p className="font-medium">후기에 나온 아쉬운 점</p>
              {script.reviewInsights.cons.length === 0 ? <p>없음</p> : script.reviewInsights.cons.map((c) => <p key={c}>🤔 {c}</p>)}
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="shrink-0">배경음악</span>
            <select
              value={script.bgmMood}
              onChange={(e) => setScript({ ...script, bgmMood: e.target.value })}
              className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
            >
              {BGM_GROUPS.map(({ group, items }) => (
                <optgroup key={group} label={group}>
                  {items.map((e) => (
                    <option key={e.mood} value={e.mood}>
                      {e.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <AudioPreviewButton kind="bgm" name={script.bgmMood} />
          </div>

          <ol className="flex flex-col gap-2">
            {script.scenes.map((scene, i) => {
              const quoteOk = !scene.reviewQuote || isQuoteFromReviews(scene.reviewQuote, reviewsUsed);
              return (
                <li key={scene.index} className="flex gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 업로드한 상품 사진 */}
                  <img src={scene.imageUrl} alt={`장면 ${i + 1} 사진`} className="h-20 w-20 shrink-0 rounded bg-white object-contain" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span>장면 {i + 1}</span>
                      <button
                        type="button"
                        onClick={() => removeScene(i)}
                        disabled={script.scenes.length <= MIN_PRODUCT_SCENES}
                        className="rounded px-1.5 hover:text-red-600 disabled:opacity-40"
                      >
                        빼기
                      </button>
                    </div>
                    <textarea
                      value={scene.narration}
                      onChange={(e) => updateScene(i, { narration: e.target.value })}
                      rows={2}
                      className="w-full resize-y rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                    />
                    <div className="flex items-start gap-1">
                      <select
                        value={scene.reviewRating}
                        onChange={(e) => updateScene(i, { reviewRating: Number(e.target.value) })}
                        className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs text-amber-600 dark:border-zinc-700"
                        aria-label="후기 별점"
                      >
                        {[5, 4, 3, 2, 1].map((n) => (
                          <option key={n} value={n}>
                            {"★".repeat(n)}
                          </option>
                        ))}
                      </select>
                      <textarea
                        value={scene.reviewQuote}
                        onChange={(e) => updateScene(i, { reviewQuote: e.target.value })}
                        rows={2}
                        placeholder="화면에 띄울 후기 (비우면 카드 없음)"
                        className={`min-w-0 flex-1 resize-y rounded border bg-transparent px-2 py-0.5 text-xs text-zinc-700 dark:text-zinc-300 ${
                          quoteOk ? "border-zinc-300 dark:border-zinc-700" : "border-red-400"
                        }`}
                      />
                    </div>
                    {!quoteOk && (
                      <p className="text-[11px] text-red-600 dark:text-red-400">
                        붙여 넣은 후기 원문에 없는 문장이에요. 후기는 고치지 말고 원문 그대로 써 주세요.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select
                        value={scene.imageIndex}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          updateScene(i, { imageIndex: n, imageUrl: uploadedUrls[n - 1] });
                        }}
                        className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700"
                      >
                        {uploadedUrls.map((_, n) => (
                          <option key={n} value={n + 1}>
                            사진 {n + 1}
                          </option>
                        ))}
                      </select>
                      <select
                        value={scene.sfx}
                        onChange={(e) => updateScene(i, { sfx: e.target.value })}
                        className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-zinc-700"
                      >
                        {SFX_GROUPS.map(({ group, items }) => (
                          <optgroup key={group} label={group}>
                            {items.map((e) => (
                              <option key={e.cue} value={e.cue}>
                                {e.label}
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
          <AudioHelp />

          <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">영상(MP4)은 PC에서 뽑아요</p>
            <a
              href={projectUrl}
              download="shorts-project.json"
              className="self-start rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black"
            >
              프로젝트 파일 내려받기
            </a>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              내려받은 뒤 PC에서 <b>쇼츠만들기.bat</b>을 실행하세요(<b>쇼츠-자동만들기.bat</b>을 켜 두면 알아서 만들어져요).
              상품 사진은 잘리지 않게 통째로 나오고, 후기 장면에는 ⭐ 후기 카드가 떠요.
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">업로드할 때 복사해서 쓰세요</p>
            <CopyBox label="제목" value={script.youtubeTitle} />
            <CopyBox label="설명란 (링크·광고 문구 포함)" value={script.description} />
            <CopyBox label="고정 댓글" value={script.pinnedComment} />
            <div className="rounded-lg border border-zinc-200 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">업로드 전 체크 (계정 보호용)</p>
              <p>☐ 세부정보 → 고급 설정 → <b>&ldquo;변경되거나 합성된 콘텐츠&rdquo;</b>: 예 (AI 인물·음성이 나올 때)</p>
              <p>☐ 고급 설정 → <b>&ldquo;유료 프로모션 포함&rdquo;</b> 체크</p>
              <p>☐ 고정 댓글 올리고 <b>고정</b>하기</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

type JobStatus =
  | "idle"
  | "planning"
  | "generating"
  | "reviewable"
  | "editing"
  | "completed"
  | "failed";

type JobSummary = {
  id: string;
  status: JobStatus;
  style: string;
  estimatedCostCents: number | null;
  spentCents: number;
  sceneCount: number;
  readySceneCount: number;
  thumbnailUrl: string | null;
  error: string | null;
  createdAt: string;
};

const STYLE_LABEL: Record<string, string> = {
  comic: "코믹 썰",
  jeju_travel: "제주 여행 소개",
  emotional: "감성 영상",
  product_ad: "제품 광고",
};

const STATUS_LABEL: Record<JobStatus, string> = {
  idle: "대기",
  planning: "계획 생성 중",
  generating: "생성 중",
  reviewable: "검토 가능",
  editing: "편집 중",
  completed: "완료",
  failed: "실패",
};

const money = (cents: number | null): string =>
  cents == null ? "-" : `$${(cents / 100).toFixed(2)}`;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function VideoJobHistoryPage() {
  const { user, loading: userLoading } = useSupabaseUser();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("로그인이 필요합니다.");
        const res = await fetch("/api/shorts/video/jobs", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "목록을 불러오지 못했습니다.");
        if (!cancelled) setJobs(data.jobs);
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">로그인 후 이용할 수 있습니다.</p>
        <Link href="/login" className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black">로그인</Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-white">내가 만든 AI 영상 쇼츠</h1>
        <Link href="/shorts/video" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">+ 새로 만들기</Link>
      </div>

      {errorMessage && <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>}

      {jobs === null && !errorMessage && (
        <p className="text-sm text-zinc-500">불러오는 중...</p>
      )}

      {jobs !== null && jobs.length === 0 && (
        <p className="text-sm text-zinc-500">아직 만든 영상이 없어요.</p>
      )}

      {jobs && jobs.length > 0 && (
        <ol className="grid w-full max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/shorts/video?job=${job.id}`}
                className="flex flex-col gap-1.5 rounded-xl border border-zinc-200 p-2 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                {job.thumbnailUrl ? (
                  job.thumbnailUrl.endsWith(".mp4") ? (
                    <video src={job.thumbnailUrl} muted className="aspect-[9/16] w-full rounded-lg object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- 원본 스토리지 URL
                    <img src={job.thumbnailUrl} alt="" className="aspect-[9/16] w-full rounded-lg object-cover" />
                  )
                ) : (
                  <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg bg-zinc-200 text-xs text-zinc-400 dark:bg-zinc-900">
                    이미지 없음
                  </div>
                )}
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {STYLE_LABEL[job.style] ?? job.style}
                </span>
                <span className="text-xs text-zinc-400">
                  {STATUS_LABEL[job.status]} · {job.readySceneCount}/{job.sceneCount}장면
                </span>
                <span className="text-xs text-zinc-400">
                  {money(job.spentCents)} / {money(job.estimatedCostCents)}
                </span>
                <span className="text-[10px] text-zinc-400">{formatDate(job.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

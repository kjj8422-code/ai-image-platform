"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// Supabase 로그인 오류는 영어로 온다("Invalid login credentials"). 자주 나오는 것만
// 우리말로 바꾸고, 모르는 오류는 원문을 그대로 보여 준다(원인 파악용).
const toKoreanAuthError = (message: string): string => {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) {
    return "이메일 또는 비밀번호가 맞지 않아요.";
  }
  if (lower.includes("email not confirmed")) {
    return "이메일 인증이 아직 안 됐어요. 초대 메일의 링크를 먼저 눌러 주세요.";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.";
  }
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "인터넷 연결을 확인해 주세요.";
  }
  return message;
};

// 개인/초대 전용 도구로 전환 — 공개 회원가입은 제공하지 않는다.
// 계정은 Supabase 대시보드의 "Invite user" 기능으로만 생성한다.
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        throw error;
      }
      router.push("/");
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? toKoreanAuthError(err.message)
          : "알 수 없는 오류가 발생했습니다.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="mb-2 text-center text-2xl font-semibold text-black dark:text-white">
          로그인
        </h1>
        <p className="mb-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
          초대받은 계정으로만 로그인할 수 있습니다.
        </p>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <label
              htmlFor="email"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              이메일
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="password"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              비밀번호
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:focus:border-white"
              placeholder="6자 이상"
            />
          </div>

          {errorMessage && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {isSubmitting ? "처리 중..." : "로그인"}
          </button>
        </form>
      </div>
    </div>
  );
}

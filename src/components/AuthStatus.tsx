"use client";

import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

export const AuthStatus = () => {
  const { user, loading } = useSupabaseUser();

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // 로그아웃 실패는 사용자 경험에 큰 영향이 없으므로 조용히 무시한다.
    }
  };

  if (loading) {
    return <p className="text-sm text-zinc-500">로그인 상태 확인 중...</p>;
  }

  if (!user) {
    return (
      <Link
        href="/login"
        className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        로그인
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-zinc-700 dark:text-zinc-300">
        {user.email}님 환영합니다
      </span>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        className="font-medium text-red-600 hover:underline dark:text-red-400"
      >
        로그아웃
      </button>
    </div>
  );
};

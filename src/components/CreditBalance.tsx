"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useSupabaseUser } from "@/lib/useSupabaseUser";

type LoadState = "loading" | "loaded" | "error";

export const CreditBalance = () => {
  const { user, loading: userLoading } = useSupabaseUser();
  const [balance, setBalance] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    if (userLoading) {
      return;
    }

    if (!user) {
      setState("loaded");
      setBalance(null);
      return;
    }

    let isMounted = true;

    const loadBalance = async () => {
      try {
        const { data, error } = await supabase
          .from("credit_wallets")
          .select("balance")
          .eq("user_id", user.id)
          .single();

        if (error) {
          throw error;
        }

        if (isMounted) {
          setBalance(data?.balance ?? 0);
          setState("loaded");
        }
      } catch {
        if (isMounted) {
          setState("error");
        }
      }
    };

    void loadBalance();

    return () => {
      isMounted = false;
    };
  }, [user, userLoading]);

  if (userLoading || !user) {
    return null;
  }

  if (state === "loading") {
    return <p className="text-xs text-zinc-400">크레딧 조회 중...</p>;
  }

  if (state === "error") {
    return <p className="text-xs text-red-500">크레딧 조회 실패</p>;
  }

  return (
    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
      보유 크레딧: <span className="text-black dark:text-white">{balance}</span>장
    </p>
  );
};

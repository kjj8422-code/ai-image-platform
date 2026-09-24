"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { resolvePreviewFile } from "@/lib/audioCatalog";

// 효과음·배경음악 선택 칸 옆의 ▶ 미리듣기 버튼.
//
// 소리는 로그인한 사람만 받을 수 있는 /api/audio/preview에서 가져온다. <audio src>로는
// 로그인 토큰을 실어 보낼 수 없어서, 토큰을 붙여 받은 파일을 브라우저 메모리 주소
// (objectURL)로 만들어 튼다. 한 번 받은 소리는 다시 받지 않는다.

// 배경음악은 곡 전체가 1~3분이라, 분위기만 확인하도록 앞부분만 들려준다.
const BGM_PREVIEW_SECONDS = 15;
const PREVIEW_VOLUME = 0.8;

const loadedUrls = new Map<string, string>();

// 화면 전체에서 한 번에 한 소리만 나게 한다. 다른 버튼을 누르면 앞 소리는 멈추고,
// 멈춘 버튼도 ▶로 돌아가도록 모든 버튼에 "지금 누가 재생 중인지"를 알린다.
let current: { key: string; audio: HTMLAudioElement; timer?: ReturnType<typeof setTimeout> } | null = null;
const listeners = new Set<(playingKey: string) => void>();

const announce = () => {
  const key = current?.key ?? "";
  listeners.forEach((listener) => listener(key));
};

const stopCurrent = () => {
  if (!current) return;
  current.audio.pause();
  if (current.timer) clearTimeout(current.timer);
  current = null;
  announce();
};

const fetchPreviewUrl = async (kind: string, name: string): Promise<string> => {
  const key = `${kind}/${name}`;
  const cached = loadedUrls.get(key);
  if (cached) return cached;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("로그인이 필요합니다.");

  const response = await fetch(
    `/api/audio/preview?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${session.access_token}` } },
  );
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error ?? "소리를 불러오지 못했습니다.");
  }
  const url = URL.createObjectURL(await response.blob());
  loadedUrls.set(key, url);
  return url;
};

type Props = { kind: "sfx" | "bgm"; name: string };

export const AudioPreviewButton = ({ kind, name }: Props) => {
  const file = resolvePreviewFile(kind, name);
  const key = file ? `${file.kind}/${file.name}` : "";
  const [playingKey, setPlayingKey] = useState<string>(current?.key ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listeners.add(setPlayingKey);
    return () => {
      listeners.delete(setPlayingKey);
    };
  }, []);

  const isPlaying = key !== "" && playingKey === key;

  if (!file) {
    return (
      <button
        type="button"
        disabled
        title="PC에 직접 넣는 소리라 웹에서는 미리 들을 수 없어요"
        className="shrink-0 rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-300 dark:border-zinc-800 dark:text-zinc-600"
      >
        ▶
      </button>
    );
  }

  const handleClick = async () => {
    if (isPlaying) {
      stopCurrent();
      return;
    }
    stopCurrent();
    setError("");
    setLoading(true);
    try {
      const url = await fetchPreviewUrl(file.kind, file.name);
      const audio = new Audio(url);
      audio.volume = PREVIEW_VOLUME;
      audio.onended = () => {
        if (current?.audio === audio) stopCurrent();
      };
      current = { key, audio };
      if (file.kind === "bgm") {
        current.timer = setTimeout(() => {
          if (current?.audio === audio) stopCurrent();
        }, BGM_PREVIEW_SECONDS * 1000);
      }
      announce();
      await audio.play();
    } catch (err) {
      stopCurrent();
      setError(err instanceof Error ? err.message : "재생하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const title = error
    ? `${error} (다시 누르면 다시 시도해요)`
    : isPlaying
      ? "멈추기"
      : file.isStandIn
        ? "이 칸이 비어 있을 때 대신 나오는 기본 곡을 들려줘요. PC에 곡을 넣었다면 영상에는 그 곡이 나와요."
        : kind === "bgm"
          ? `미리듣기 (앞 ${BGM_PREVIEW_SECONDS}초)`
          : "미리듣기";

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={loading}
      title={title}
      aria-label={isPlaying ? "미리듣기 멈추기" : "미리듣기"}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50 ${
        error
          ? "border-red-300 text-red-600 dark:border-red-800 dark:text-red-400"
          : isPlaying
            ? "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
            : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      }`}
    >
      {loading ? "…" : isPlaying ? "■" : error ? "!" : "▶"}
    </button>
  );
};

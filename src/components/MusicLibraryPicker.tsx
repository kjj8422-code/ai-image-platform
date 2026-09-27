"use client";

import { useState } from "react";
import tracks from "@/lib/musicLibrary.json";
import { AudioPreviewButton } from "./AudioPreviewButton";

export function MusicLibraryPicker({ value, onChange, disabled = false }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [genre, setGenre] = useState("");
  const selected = tracks.find(t => t.id === value);
  const matches = tracks.filter(t => (!group || t.group === group) && (!genre || t.genre === genre) && `${t.title} ${t.artist}`.toLowerCase().includes(query.toLowerCase().trim()));
  const field = "min-w-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-white";
  return <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
    <h2 className="font-semibold">내 오디오모음 · {tracks.length}곡</h2>
    <p className="text-xs text-zinc-500">분위기·장르는 추정 분류입니다. 15초 미리듣기로 확인하고 원하는 곡을 선택하세요.</p>
    <input aria-label="곡명 또는 아티스트 검색" placeholder="곡명 또는 아티스트 검색" value={query} onChange={e => setQuery(e.target.value)} className={field} />
    <div className="grid grid-cols-2 gap-2">
      <select aria-label="음악 분위기 필터" value={group} onChange={e => setGroup(e.target.value)} className={field}><option value="">모든 분위기</option>{[...new Set(tracks.map(t => t.group))].map(g => <option key={g}>{g}</option>)}</select>
      <select aria-label="음악 장르 필터" value={genre} onChange={e => setGenre(e.target.value)} className={field}><option value="">모든 장르</option>{[...new Set(tracks.map(t => t.genre))].map(g => <option key={g}>{g}</option>)}</select>
    </div>
    <div role="status" className="text-sm">선택: {selected ? `${selected.title} — ${selected.artist}` : "기본 배경음악 / AI 추천"}</div>
    {selected && <button type="button" disabled={disabled} className="self-start text-xs text-blue-600 underline" onClick={() => onChange("")}>곡 선택 해제 · 기본 음악 사용</button>}
    <p className="text-xs text-zinc-500">검색 결과 {matches.length}곡</p>
    <ul className="max-h-64 overflow-y-auto divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {matches.map(t => <li key={t.id} className={`flex items-center gap-3 p-3 ${t.id === value ? "bg-blue-50 dark:bg-blue-950" : ""}`}>
        <button type="button" disabled={disabled} aria-pressed={t.id === value} onClick={() => onChange(t.id)} className="min-w-0 flex-1 text-left disabled:opacity-50">
          <span className="block text-sm font-medium">{t.id === value ? "✓ " : ""}{t.title}</span>
          <span className="block truncate text-xs text-zinc-500">{t.artist}</span>
          <span className="text-xs text-zinc-500">{t.group} · {t.genre} · {Math.floor(t.duration / 60)}:{String(Math.floor(t.duration % 60)).padStart(2, "0")}</span>
        </button>
        <AudioPreviewButton kind="bgm" name={t.id} />
      </li>)}
      {!matches.length && <li className="p-4 text-sm text-zinc-500">조건에 맞는 곡이 없습니다. 검색어나 분류를 바꿔 주세요.</li>}
    </ul>
    <p className="text-xs text-zinc-500">최종 합성은 PC의 Downloads/오디오모음 원본을 사용합니다. 최신 PC 합성기로 업데이트한 뒤 이 폴더를 그대로 유지하세요. 웹에는 미리듣기만 저장됩니다.</p>
  </section>;
}

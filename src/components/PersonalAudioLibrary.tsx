"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { AUDIO_GENRES, AUDIO_MOODS, recommendedAudioMood, type PersonalAudio } from "@/lib/personalAudio";

async function api(query = "", body?: unknown) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("로그인이 필요합니다.");
  const response = await fetch(`/api/audio/library${query}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "음원 요청 실패");
  return result;
}

export function PersonalAudioLibrary({ mood, onSelection }: { mood?: string; onSelection: (track: PersonalAudio | null) => void }) {
  const [tracks, setTracks] = useState<PersonalAudio[]>([]);
  const [choice, setChoice] = useState("auto");
  const [genre, setGenre] = useState("");
  const [filterMood, setFilterMood] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [editing, setEditing] = useState<PersonalAudio | null>(null);
  const reload = useCallback(async () => {
    try { setTracks((await api()).tracks); }
    catch (error) { setMessage(error instanceof Error ? error.message : "목록 불러오기 실패"); }
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => api().then(result => { if (active) setTracks(result.tracks); }).catch(error => { if (active) setMessage(error instanceof Error ? error.message : "목록 불러오기 실패"); });
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const suggested = useMemo(() => tracks.filter(t => t.kind === "bgm" && mood && t.mood === recommendedAudioMood(mood)).sort((a, b) => a.title.localeCompare(b.title))[0], [tracks, mood]);
  const selected = choice === "auto" ? suggested ?? null : tracks.find(t => t.id === choice) ?? null;
  useEffect(() => { onSelection(selected); }, [selected, onSelection]);
  const filtered = tracks.filter(t => (!genre || t.genre === genre) && (!filterMood || t.mood === filterMood) && `${t.title} ${t.artist}`.toLowerCase().includes(search.toLowerCase()));
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : "요청 실패"); }
    finally { setBusy(false); }
  };
  const control = "rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700";
  return <section className="flex w-full max-w-2xl flex-col gap-3 rounded-2xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">내 음원 보관함 · {tracks.length}개</h2>
      <button type="button" className={control} onClick={() => void reload()}>새로고침</button>
    </div>
    <p className="text-xs text-zinc-500">장르·분위기로 찾고 미리 들어보세요. 자동 추천은 대본의 분위기와 일치하는 내 BGM을 사용합니다. 일치하는 곡이 없으면 기본 BGM을 사용해요.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={control} onClick={() => void action(async () => {
        const connection = await api("", { action: "pair" });
        const url = URL.createObjectURL(new Blob([JSON.stringify(connection)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "audio-sync-connection.json"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("연결 파일을 다운로드했습니다. PC의 음원-자동동기화 실행기에 연결해주세요. 연결은 1년간 유지되며, 파일은 공유하지 마세요.");
      })}>PC 폴더 연결 파일 받기</button>
      <button type="button" disabled={busy} className={control} onClick={() => void action(async () => {
        await api("", { action: "revoke" }); setMessage("PC 연결을 해제했습니다. 등록한 음원은 유지됩니다.");
      })}>PC 연결 해제</button>
    </div>
    <label className="flex flex-col gap-1">쇼츠에 사용할 배경음악
      <select aria-label="내 배경음악 선택" className={control} value={choice} onChange={e => setChoice(e.target.value)}>
        <option value="auto">자동 추천{suggested ? ` · ${suggested.title}` : " · 기본 BGM"}</option>
        <option value="builtin">기본 BGM 사용</option>
        {tracks.filter(t => t.kind === "bgm").map(t => <option key={t.id} value={t.id}>{t.title} · {t.mood}</option>)}
      </select>
    </label>
    {selected && <p className="text-xs text-blue-600">적용할 곡: {selected.title} — {selected.artist}{selected.attribution ? ` · 출처 표기: ${selected.attribution}` : " · 출처 표기 조건은 원본 다운로드 페이지에서 확인해주세요."}</p>}
    <div className="flex flex-wrap gap-2">
      <input className={`${control} min-w-0 flex-1`} aria-label="음원 검색" placeholder="곡명·아티스트 검색" value={search} onChange={e => setSearch(e.target.value)} />
      <select className={control} aria-label="장르 필터" value={genre} onChange={e => setGenre(e.target.value)}><option value="">모든 장르</option>{AUDIO_GENRES.map(g => <option key={g}>{g}</option>)}</select>
      <select className={control} aria-label="분위기 필터" value={filterMood} onChange={e => setFilterMood(e.target.value)}><option value="">모든 분위기</option>{AUDIO_MOODS.map(m => <option key={m}>{m}</option>)}</select>
    </div>
    <div className="max-h-72 overflow-y-auto">
      {filtered.map(t => <div key={t.id} className="flex items-center justify-between gap-2 border-b border-zinc-200 py-2 dark:border-zinc-800">
        <div className="min-w-0"><p className="truncate font-medium">{t.title}</p><p className="text-xs text-zinc-500">{t.artist} · {t.genre} · {t.mood} · {Math.round(t.duration)}초{t.classification === "estimated" ? " · 자동 추정" : ""}</p></div>
        <div className="flex shrink-0 gap-2">
          <button aria-label={`${t.title} 미리듣기`} disabled={busy} onClick={() => void action(async () => { const result = await api(`?id=${t.id}`); setPreview({ id: t.id, url: result.url }); })}>▶</button>
          {t.kind === "bgm" && <button onClick={() => setChoice(t.id)}>선택</button>}
          <button onClick={() => setEditing({ ...t })}>수정</button>
        </div>
      </div>)}
      {!tracks.length && <p className="py-4 text-zinc-500">PC 폴더를 연결하면 음원이 여기에 나타납니다.</p>}
      {tracks.length > 0 && !filtered.length && <p className="py-4 text-zinc-500">조건에 맞는 음원이 없습니다.</p>}
    </div>
    {preview && <audio key={preview.url} src={preview.url} controls autoPlay className="w-full" onError={() => setMessage("미리듣기 주소가 만료되었거나 재생할 수 없습니다. ▶를 다시 눌러주세요.")} />}
    {editing && <div className="flex flex-col gap-2 rounded border p-3">
      <p>{editing.title} 분류 수정</p>
      <select aria-label="장르 수정" className={control} value={editing.genre} onChange={e => setEditing({ ...editing, genre: e.target.value })}>{AUDIO_GENRES.map(g => <option key={g}>{g}</option>)}</select>
      <select aria-label="분위기 수정" className={control} value={editing.mood} onChange={e => setEditing({ ...editing, mood: e.target.value })}>{AUDIO_MOODS.map(m => <option key={m}>{m}</option>)}</select>
      <textarea aria-label="출처 표기 문구" className={control} placeholder="원본 라이선스에서 요구하는 출처 표기 문구" value={editing.attribution} onChange={e => setEditing({ ...editing, attribution: e.target.value })} />
      <div className="flex gap-3"><button disabled={busy} onClick={() => void action(async () => { await api("", { action: "save", track: editing }); setEditing(null); await reload(); })}>저장</button><button onClick={() => setEditing(null)}>취소</button></div>
    </div>}
    {message && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{message}</p>}
    <p className="text-xs text-zinc-500">내 계정에만 표시됩니다. PC가 켜져 있고 동기화 실행기가 동작할 때 새 파일이 등록됩니다. 자동 추정 분류는 수정할 수 있습니다.</p>
  </section>;
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/requireUser";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { AUDIO_GENRES, AUDIO_MOODS } from "@/lib/personalAudio";

export const runtime = "nodejs";
export const maxDuration = 60;
const BUCKET = "personal-audio";
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const trackSchema = z.object({
  id: idSchema, title: z.string().min(1).max(200), artist: z.string().max(200),
  genre: z.enum(AUDIO_GENRES as [string, ...string[]]),
  mood: z.enum(AUDIO_MOODS as [string, ...string[]]), kind: z.enum(["bgm", "sfx"]),
  duration: z.number().positive().max(7200), classification: z.enum(["estimated", "manual"]),
  attribution: z.string().max(4000).default(""),
});
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function storage() {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.storage.getBucket(BUCKET);
  if (!data) {
    const created = await admin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 50 * 1024 * 1024, allowedMimeTypes: ["audio/mpeg", "application/json"] });
    if (created.error) {
      const retry = await admin.storage.getBucket(BUCKET);
      if (!retry.data || retry.data.public) throw new Error(created.error.message || error?.message);
    }
  } else if (data.public) throw new Error("음원 보관함이 비공개로 설정되어야 합니다.");
  return admin.storage.from(BUCKET);
}

// A revocable, audio-only device credential. It cannot call other application APIs.
async function identity(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token.startsWith("audio1.")) {
    const auth = await requireUser(request);
    return "error" in auth ? null : { uid: auth.user.id, device: false };
  }
  const match = /^audio1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const { data } = await (await storage()).download(`${match[1]}/device.json`);
  if (!data) return null;
  const record = JSON.parse(await data.text());
  const actual = Buffer.from(digest(token));
  const expected = Buffer.from(String(record.digest));
  if (record.expires < Date.now() || expected.length !== actual.length || !timingSafeEqual(actual, expected)) return null;
  return { uid: match[1], device: true };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await identity(request);
    if (!auth) return json({ error: "로그인 또는 폴더 연결을 다시 해주세요." }, 401);
    const store = await storage();
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      if (!idSchema.safeParse(id).success) return json({ error: "잘못된 음원 번호" }, 400);
      const { data, error } = await store.createSignedUrl(`${auth.uid}/audio/${id}.mp3`, 300);
      if (error) throw error;
      return json({ url: data.signedUrl });
    }
    // Paginate storage listings; each track is an independent record, so concurrent
    // uploads never overwrite a shared catalog manifest.
    const names: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await store.list(`${auth.uid}/tracks`, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      names.push(...data.filter(f => /^[a-f0-9]{64}\.json$/.test(f.name)).map(f => f.name));
      if (data.length < 100) break;
    }
    if (request.nextUrl.searchParams.get("ids") === "1") return json({ ids: names.map(name => name.slice(0, -5)) });
    const tracks = [];
    for (let start = 0; start < names.length; start += 12) {
      tracks.push(...await Promise.all(names.slice(start, start + 12).map(async name => {
        const { data, error } = await store.download(`${auth.uid}/tracks/${name}`);
        if (error || !data) throw error ?? new Error("목록 읽기 실패");
        return trackSchema.parse(JSON.parse(await data.text()));
      })));
    }
    return json({ tracks });
  } catch (error) {
    console.error("audio library read", error);
    return json({ error: "음원 보관함을 읽지 못했습니다. 잠시 후 다시 시도해주세요." }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await identity(request);
    if (!auth) return json({ error: "로그인 또는 폴더 연결을 다시 해주세요." }, 401);
    const body = await request.json();
    const store = await storage();
    if (body.action === "pair" || body.action === "revoke") {
      if (auth.device) return json({ error: "사이트 로그인이 필요합니다." }, 403);
      if (body.action === "revoke") {
        const { error } = await store.remove([`${auth.uid}/device.json`]);
        if (error) throw error;
        return json({ ok: true });
      }
      const token = `audio1.${auth.uid}.${randomBytes(32).toString("hex")}`;
      const expires = Date.now() + 365 * 86400000;
      const { error } = await store.upload(`${auth.uid}/device.json`, JSON.stringify({ digest: digest(token), expires }), { upsert: true, contentType: "application/json" });
      if (error) throw error;
      return json({ version: 1, baseUrl: request.nextUrl.origin, token, expires });
    }
    if (body.action === "upload") {
      const id = idSchema.parse(body.id);
      const { data, error } = await store.createSignedUploadUrl(`${auth.uid}/audio/${id}.mp3`, { upsert: true });
      if (error) throw error;
      return json({ url: data.signedUrl });
    }
    if (body.action === "save") {
      let track = trackSchema.parse(body.track);
      const objectPath = `${auth.uid}/tracks/${track.id}.json`;
      // Automatic re-sync must not erase edits the user made on the website.
      if (auth.device) {
        const old = await store.download(objectPath);
        if (old.data) {
          const saved = trackSchema.parse(JSON.parse(await old.data.text()));
          if (saved.classification === "manual") track = saved;
        }
      } else track.classification = "manual";
      const { data, error: listError } = await store.list(`${auth.uid}/audio`, { search: `${track.id}.mp3`, limit: 1 });
      if (listError) throw listError;
      if (!data?.some(f => f.name === `${track.id}.mp3`)) return json({ error: "음원 업로드가 끝나지 않았습니다." }, 409);
      const { error } = await store.upload(objectPath, JSON.stringify(track), { upsert: true, contentType: "application/json" });
      if (error) throw error;
      return json({ ok: true });
    }
    return json({ error: "지원하지 않는 요청" }, 400);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "음원 정보 형식을 확인해주세요." }, 400);
    console.error("audio library write", error);
    return json({ error: "음원 저장에 실패했습니다. 보관함 용량과 서버 설정을 확인해주세요." }, 500);
  }
}

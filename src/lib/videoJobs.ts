import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { SfxCue } from "@/lib/shortsStoryboard";

// video_jobs / video_scenes 테이블 접근 계층. 라우트는 이 함수들만 쓰고 직접
// supabaseAdmin을 만지지 않는다 — 소유권 검증(user_id 조건)을 여기 한 곳에 모아두면
// 라우트마다 까먹을 위험이 없다.

export const JOB_STATUSES = [
  "idle",
  "planning",
  "generating",
  "reviewable",
  "editing",
  "completed",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SCENE_STATUSES = [
  "queued",
  "generating",
  "ready",
  "selected",
  "failed",
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export type VideoStyle = "comic" | "jeju_travel" | "emotional" | "product_ad";

export type VideoJob = {
  id: string;
  userId: string;
  status: JobStatus;
  sourceImageUrls: string[];
  keepOrder: boolean;
  useAllImages: boolean;
  style: VideoStyle;
  narrationEnabled: boolean;
  subtitleEnabled: boolean;
  provider: string | null;
  idempotencyKey: string;
  estimatedCostCents: number | null;
  maxBudgetCents: number | null;
  spentCents: number;
  finalVideoUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GenerationHistoryEntry = {
  providerJobId: string;
  videoUrl: string | null;
  costCents: number;
  createdAt: string;
  // pending: 제출 직후, 아직 결과를 모름 (costCents는 예상치). ready/failed로 갱신된다.
  status: "pending" | "ready" | "failed";
  error?: string;
};

export type VideoScene = {
  id: string;
  jobId: string;
  sceneIndex: number;
  sourceImageUrl: string;
  referenceImageUrls: string[];
  narration: string | null;
  subtitle: string | null;
  keyAction: string | null;
  cameraMotion: string | null;
  preserveNotes: string | null;
  prompt: string | null;
  sfx: SfxCue;
  durationTargetSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number | null;
  providerJobId: string | null;
  providerModel: string | null;
  status: SceneStatus;
  providerRawUrl: string | null;
  videoUrl: string | null;
  error: string | null;
  generationHistory: GenerationHistoryEntry[];
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  user_id: string;
  status: JobStatus;
  source_image_urls: string[];
  keep_order: boolean;
  use_all_images: boolean;
  style: VideoStyle;
  narration_enabled: boolean;
  subtitle_enabled: boolean;
  provider: string | null;
  idempotency_key: string;
  estimated_cost_cents: number | null;
  max_budget_cents: number | null;
  spent_cents: number;
  final_video_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type SceneRow = {
  id: string;
  job_id: string;
  scene_index: number;
  source_image_url: string;
  reference_image_urls: string[];
  narration: string | null;
  subtitle: string | null;
  key_action: string | null;
  camera_motion: string | null;
  preserve_notes: string | null;
  prompt: string | null;
  sfx: SfxCue;
  duration_target_seconds: number;
  trim_start_seconds: number;
  trim_end_seconds: number | null;
  provider_job_id: string | null;
  provider_model: string | null;
  status: SceneStatus;
  provider_raw_url: string | null;
  video_url: string | null;
  error: string | null;
  generation_history: GenerationHistoryEntry[];
  last_polled_at: string | null;
  created_at: string;
  updated_at: string;
};

const toJob = (row: JobRow): VideoJob => ({
  id: row.id,
  userId: row.user_id,
  status: row.status,
  sourceImageUrls: row.source_image_urls,
  keepOrder: row.keep_order,
  useAllImages: row.use_all_images,
  style: row.style,
  narrationEnabled: row.narration_enabled,
  subtitleEnabled: row.subtitle_enabled,
  provider: row.provider,
  idempotencyKey: row.idempotency_key,
  estimatedCostCents: row.estimated_cost_cents,
  maxBudgetCents: row.max_budget_cents,
  spentCents: row.spent_cents,
  finalVideoUrl: row.final_video_url,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toScene = (row: SceneRow): VideoScene => ({
  id: row.id,
  jobId: row.job_id,
  sceneIndex: row.scene_index,
  sourceImageUrl: row.source_image_url,
  referenceImageUrls: row.reference_image_urls ?? [],
  narration: row.narration,
  subtitle: row.subtitle,
  keyAction: row.key_action,
  cameraMotion: row.camera_motion,
  preserveNotes: row.preserve_notes,
  prompt: row.prompt,
  sfx: row.sfx,
  durationTargetSeconds: row.duration_target_seconds,
  trimStartSeconds: row.trim_start_seconds,
  trimEndSeconds: row.trim_end_seconds,
  providerJobId: row.provider_job_id,
  providerModel: row.provider_model,
  status: row.status,
  providerRawUrl: row.provider_raw_url,
  videoUrl: row.video_url,
  error: row.error,
  generationHistory: row.generation_history ?? [],
  lastPolledAt: row.last_polled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type NewJobInput = {
  userId: string;
  idempotencyKey: string;
  sourceImageUrls: string[];
  keepOrder: boolean;
  useAllImages: boolean;
  style: VideoStyle;
  narrationEnabled: boolean;
  subtitleEnabled: boolean;
};

// 같은 idempotencyKey로 다시 오면(더블클릭, 네트워크 재시도) 새로 만들지 않고
// 기존 job을 그대로 돌려준다. unique(user_id, idempotency_key) 제약이 동시 요청
// 경쟁 상태에서도 이를 보장한다.
export const findJobByIdempotencyKey = async (
  userId: string,
  idempotencyKey: string,
): Promise<VideoJob | null> => {
  const { data, error } = await getSupabaseAdmin()
    .from("video_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data ? toJob(data as JobRow) : null;
};

export const createVideoJob = async (input: NewJobInput): Promise<VideoJob> => {
  const { data, error } = await getSupabaseAdmin()
    .from("video_jobs")
    .insert({
      user_id: input.userId,
      idempotency_key: input.idempotencyKey,
      source_image_urls: input.sourceImageUrls,
      keep_order: input.keepOrder,
      use_all_images: input.useAllImages,
      style: input.style,
      narration_enabled: input.narrationEnabled,
      subtitle_enabled: input.subtitleEnabled,
      status: "idle",
    })
    .select("*")
    .single();
  if (error) throw error;
  return toJob(data as JobRow);
};

// "내가 만든 영상 목록" 화면용. planning 단계에서 실패해 장면이 하나도 없는
// job까지 전부 보여줘야 사용자가 뭐가 잘못됐는지 알 수 있으므로 걸러내지 않는다.
export const listJobsForUser = async (userId: string): Promise<VideoJob[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from("video_jobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as JobRow[]).map(toJob);
};

export const getOwnedJob = async (
  userId: string,
  jobId: string,
): Promise<VideoJob | null> => {
  const { data, error } = await getSupabaseAdmin()
    .from("video_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? toJob(data as JobRow) : null;
};

export const listScenesForJob = async (jobId: string): Promise<VideoScene[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from("video_scenes")
    .select("*")
    .eq("job_id", jobId)
    .order("scene_index", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as SceneRow[]).map(toScene);
};

// 장면 순서를 바꾼다. scene_index가 (job_id, scene_index) 유니크 제약이 걸린
// "진짜 자리"라서, 새 순서를 그대로 1..N으로 덮어쓰면 중간에 값이 겹치는 순간이
// 생긴다(예: 1번을 2번 자리로 옮기는 동안 기존 2번이 아직 2번이면 충돌). 그래서
// 먼저 전부 음수(임시) 값으로 옮겨 자리를 비운 뒤, 새 순서대로 1..N을 매긴다.
export const reorderScenes = async (
  jobId: string,
  orderedSceneIds: string[],
): Promise<VideoScene[]> => {
  const supabaseAdmin = getSupabaseAdmin();

  for (const [i, sceneId] of orderedSceneIds.entries()) {
    const { error } = await supabaseAdmin
      .from("video_scenes")
      .update({ scene_index: -(i + 1) })
      .eq("id", sceneId)
      .eq("job_id", jobId);
    if (error) throw error;
  }
  for (const [i, sceneId] of orderedSceneIds.entries()) {
    const { error } = await supabaseAdmin
      .from("video_scenes")
      .update({ scene_index: i + 1, updated_at: new Date().toISOString() })
      .eq("id", sceneId)
      .eq("job_id", jobId);
    if (error) throw error;
  }

  return listScenesForJob(jobId);
};

// "내가 만든 영상 목록" 화면이 job마다 썸네일·완성 개수를 보여주려고 쓴다.
// job 하나마다 따로 조회하지 않고 한 번에 가져와 N+1을 피한다.
export const listScenesForJobs = async (jobIds: string[]): Promise<VideoScene[]> => {
  if (jobIds.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("video_scenes")
    .select("*")
    .in("job_id", jobIds)
    .order("scene_index", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as SceneRow[]).map(toScene);
};

export const getOwnedScene = async (
  userId: string,
  jobId: string,
  sceneIndex: number,
): Promise<{ job: VideoJob; scene: VideoScene } | null> => {
  const job = await getOwnedJob(userId, jobId);
  if (!job) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("video_scenes")
    .select("*")
    .eq("job_id", jobId)
    .eq("scene_index", sceneIndex)
    .maybeSingle();
  if (error) throw error;
  return data ? { job, scene: toScene(data as SceneRow) } : null;
};

export type NewSceneInput = {
  jobId: string;
  sceneIndex: number;
  sourceImageUrl: string;
  referenceImageUrls: string[];
  narration: string;
  subtitle: string;
  keyAction: string;
  cameraMotion: string;
  preserveNotes: string;
  prompt: string;
  sfx: SfxCue;
  durationTargetSeconds: number;
};

export const insertScenes = async (scenes: NewSceneInput[]): Promise<void> => {
  if (scenes.length === 0) return;
  const { error } = await getSupabaseAdmin().from("video_scenes").insert(
    scenes.map((s) => ({
      job_id: s.jobId,
      scene_index: s.sceneIndex,
      source_image_url: s.sourceImageUrl,
      reference_image_urls: s.referenceImageUrls,
      narration: s.narration,
      subtitle: s.subtitle,
      key_action: s.keyAction,
      camera_motion: s.cameraMotion,
      preserve_notes: s.preserveNotes,
      prompt: s.prompt,
      sfx: s.sfx,
      duration_target_seconds: s.durationTargetSeconds,
    })),
  );
  if (error) throw error;
};

export const updateJob = async (
  jobId: string,
  patch: Partial<{
    status: JobStatus;
    provider: string;
    estimatedCostCents: number;
    maxBudgetCents: number;
    spentCents: number;
    finalVideoUrl: string;
    error: string | null;
  }>,
): Promise<void> => {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.provider !== undefined) row.provider = patch.provider;
  if (patch.estimatedCostCents !== undefined)
    row.estimated_cost_cents = patch.estimatedCostCents;
  if (patch.maxBudgetCents !== undefined) row.max_budget_cents = patch.maxBudgetCents;
  if (patch.spentCents !== undefined) row.spent_cents = patch.spentCents;
  if (patch.finalVideoUrl !== undefined) row.final_video_url = patch.finalVideoUrl;
  if (patch.error !== undefined) row.error = patch.error;

  const { error } = await getSupabaseAdmin()
    .from("video_jobs")
    .update(row)
    .eq("id", jobId);
  if (error) throw error;
};

// job.spent_cents를 증가시킨다. read-modify-write 경쟁을 피하려고 SQL 표현식으로
// 원자적으로 더한다(같은 job의 여러 장면이 거의 동시에 완료돼도 안전).
export const incrementJobSpentCents = async (
  jobId: string,
  addCents: number,
): Promise<void> => {
  if (addCents === 0) return;
  const { error } = await getSupabaseAdmin().rpc("increment_video_job_spent", {
    p_job_id: jobId,
    p_amount: addCents,
  });
  if (error) throw error;
};

export const updateScene = async (
  sceneId: string,
  patch: Partial<{
    status: SceneStatus;
    providerJobId: string | null;
    providerModel: string | null;
    providerRawUrl: string | null;
    videoUrl: string | null;
    error: string | null;
    lastPolledAt: string;
    generationHistory: GenerationHistoryEntry[];
    narration: string;
    subtitle: string;
    prompt: string;
    sourceImageUrl: string;
    sfx: SfxCue;
  }>,
): Promise<VideoScene> => {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.providerJobId !== undefined) row.provider_job_id = patch.providerJobId;
  if (patch.providerModel !== undefined) row.provider_model = patch.providerModel;
  if (patch.providerRawUrl !== undefined) row.provider_raw_url = patch.providerRawUrl;
  if (patch.videoUrl !== undefined) row.video_url = patch.videoUrl;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.lastPolledAt !== undefined) row.last_polled_at = patch.lastPolledAt;
  if (patch.generationHistory !== undefined)
    row.generation_history = patch.generationHistory;
  if (patch.narration !== undefined) row.narration = patch.narration;
  if (patch.subtitle !== undefined) row.subtitle = patch.subtitle;
  if (patch.prompt !== undefined) row.prompt = patch.prompt;
  if (patch.sourceImageUrl !== undefined) row.source_image_url = patch.sourceImageUrl;
  if (patch.sfx !== undefined) row.sfx = patch.sfx;

  const { data, error } = await getSupabaseAdmin()
    .from("video_scenes")
    .update(row)
    .eq("id", sceneId)
    .select("*")
    .single();
  if (error) throw error;
  return toScene(data as SceneRow);
};

// cron/status-polling 양쪽에서 쓰는 "지금 생성 중인 모든 장면" 조회.
// job까지 조인해 poll에 필요한 provider/user_id를 한 번에 가져온다.
export type GeneratingSceneWithJob = { scene: VideoScene; job: VideoJob };

export const listGeneratingScenes = async (): Promise<GeneratingSceneWithJob[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from("video_scenes")
    .select("*, video_jobs(*)")
    .eq("status", "generating")
    .not("provider_job_id", "is", null);
  if (error) throw error;
  type JoinedRow = SceneRow & { video_jobs: JobRow };
  return ((data ?? []) as JoinedRow[]).map((row) => ({
    scene: toScene(row),
    job: toJob(row.video_jobs),
  }));
};

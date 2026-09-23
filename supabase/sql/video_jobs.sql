-- AI 영상 쇼츠(이미지 -> 실제 동영상 클립) 기능용 테이블.
-- Supabase 대시보드 > SQL Editor에 붙여넣어 실행한다. 기존 테이블은 건드리지 않는다.

create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- idle: 계획 전 / planning: 대본·장면 짜는 중 / generating: 영상 클립 생성 중
  -- reviewable: 장면별로 검토·재생성 가능 / editing: 음성·자막·음악 합성 중
  -- completed: 최종 mp4 완성 / failed: 실패
  status text not null default 'idle'
    check (status in ('idle','planning','generating','reviewable','editing','completed','failed')),

  -- 사용자가 고른 옵션 그대로 저장 (재생성 시에도 같은 규칙을 지키기 위해 필요)
  source_image_urls jsonb not null, -- 업로드 순서 그대로, 원본 화질
  keep_order boolean not null default false, -- true면 AI가 순서를 못 바꾼다
  use_all_images boolean not null default false, -- true면 사진을 임의로 버릴 수 없다
  style text not null default 'comic', -- comic / jeju_travel / emotional / product_ad
  narration_enabled boolean not null default true,
  subtitle_enabled boolean not null default true,

  storyboard jsonb, -- Claude가 짠 장면 계획 (장면 배열은 video_scenes가 정본, 이건 원본 응답 보관용)
  provider text, -- 예: 'runway' — 공급자 선택 확정 전까지는 null

  -- 예산/중복과금 방지
  idempotency_key text not null,
  estimated_cost_cents integer,
  max_budget_cents integer,
  spent_cents integer not null default 0,

  final_video_url text, -- 완성된 mp4 (자체 Storage, 공급자 임시 URL 아님)
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, idempotency_key) -- 같은 요청이 중복 제출돼도 서버가 같은 job으로 취급
);

create table if not exists video_scenes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references video_jobs(id) on delete cascade,
  scene_index integer not null,

  source_image_url text not null,
  reference_image_urls jsonb not null default '[]', -- 캐릭터/제품 일관성용 참조 이미지

  narration text,
  subtitle text,
  key_action text, -- 이 장면의 핵심 동작 한 줄 (모델 프롬프트 설계용)
  camera_motion text,
  preserve_notes text, -- 유지해야 할 외형/색상/소품 메모
  prompt text, -- 실제로 공급자에 보낸 최종 프롬프트

  duration_target_seconds numeric not null default 5,
  trim_start_seconds numeric not null default 0, -- 생성 길이 중 최종본에 쓸 구간
  trim_end_seconds numeric,

  provider_job_id text, -- 공급자가 준 작업 ID (상태 조회/재시도 대조용)
  provider_model text,
  status text not null default 'queued'
    check (status in ('queued','generating','ready','selected','failed')),
  provider_raw_url text, -- 공급자 임시 URL (보통 1~48시간 내 만료 — 다운로드 전까지만 씀)
  video_url text, -- 우리 Storage에 옮겨 담은 영구 URL
  error text,

  generation_history jsonb not null default '[]', -- 재생성 이력: [{providerJobId, videoUrl, costCents, createdAt}]

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (job_id, scene_index)
);

create index if not exists video_jobs_user_id_idx on video_jobs(user_id);
create index if not exists video_scenes_job_id_idx on video_scenes(job_id);

-- 다른 테이블(gallery_images)과 같은 정책: RLS는 켜두되 클라이언트용 정책은 안 만든다.
-- 모든 접근은 서버 API route가 service_role 키로만 한다 (requireUser로 소유권 검증 후).
alter table video_jobs enable row level security;
alter table video_scenes enable row level security;

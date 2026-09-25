-- AI 영상 쇼츠 장면별 효과음 칸 추가 (이미 만들어진 DB용).
-- video_jobs.sql은 새 DB를 처음 만들 때만 쓰이므로, 운영 DB에는 이 파일을 한 번 실행한다.
-- 여러 번 실행해도 안전하다(if not exists). 기존 장면은 'none'(효과음 없음)으로 채워진다.
alter table video_scenes
  add column if not exists sfx text not null default 'none';

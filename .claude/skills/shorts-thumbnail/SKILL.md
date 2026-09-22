---
name: shorts-thumbnail
description: 대본이나 주제 한 줄로 유튜브 쇼츠·인스타 릴스용 9:16 썸네일을 커맨드라인에서 자동 생성한다. 배포된 ai-image-platform API(B급 문구 추천 + Flux 배경 생성 + 서버 합성)를 그대로 호출해 PNG 파일로 저장한다. "이 대본으로 쇼츠 썸네일 만들어줘", "릴스 썸네일 생성해줘" 같은 요청에 사용한다.
---

# Shorts/Reels 썸네일 생성 스킬

`ai-image-platform` 웹 화면(`/thumbnail`)과 완전히 같은 파이프라인을 커맨드라인에서 실행한다.
새로 AI/합성 로직을 만들지 않고, 이미 배포된 API 3개를 그대로 순서대로 호출한다.
합성(문구·외곽선·그림자·그라데이션)은 서버(@napi-rs/canvas)가 처리하므로 이 스킬에는
Pillow도, 폰트 파일도 필요 없다 — 파이썬 표준 라이브러리만으로 동작한다.

## 파이프라인
1. `POST /api/thumbnail/suggest` — 대본/주제 → B급/호기심 유발 3~4단어 문구 + 영문 배경 프롬프트 추천
2. `POST /api/generate` — `format: "story"`(9:16)로 배경 이미지 여러 장 생성 (Flux 1.1 Pro)
3. `POST /api/thumbnail/compose` — 서버가 배경을 1080x1920에 맞게 자르고 상단 그라데이션 +
   18px 외곽선·그림자·형광 노랑 문구(Y≈450px, 하단 25%/우측 15% 세이프존 회피)를 합성한 PNG를 그대로 반환
4. `./thumbnails/`에 PNG로 저장

## 최초 1회 준비
```bash
cp .claude/skills/shorts-thumbnail/.env.example .claude/skills/shorts-thumbnail/.env
```
`.env`를 열어 초대받은 계정의 이메일/비밀번호를 채운다 (Supabase URL/키는 같은 저장소의
`.env.local`에 있으면 자동으로 읽어오므로 비워둬도 된다). 설치할 파이썬 패키지는 없다.

## 실행 명령
대본/주제만 넘기면 문구와 배경 프롬프트를 AI가 알아서 추천한다:
```bash
python .claude/skills/shorts-thumbnail/thumbnail_pipeline.py --topic "$ARG_TOPIC"
```

문구나 배경 프롬프트를 직접 지정해 추천 호출을 건너뛸 수도 있다:
```bash
python .claude/skills/shorts-thumbnail/thumbnail_pipeline.py \
  --title "$ARG_TITLE" --background-prompt "$ARG_BACKGROUND_PROMPT"
```

기타 옵션: `--count`(생성할 장수, 기본 4, 최대 4) · `--out-dir`(저장 폴더, 기본 `./thumbnails`).

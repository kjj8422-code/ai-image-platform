---
name: viral-shorts
description: 제주도 기반 판타지/B급 바이럴 쇼츠를 주제 한 줄로 완성 MP4까지 자동 제작한다. 6장면 썰체 대본 + 캐릭터 일관성 유지 이미지 6장 + 한국어 TTS + 단어별 자막 + SFX/BGM 타임라인을 한 번에 만든다. "이 주제로 쇼츠 만들어줘", "제주 판타지 숏폼 영상 제작", "대본부터 영상까지 자동으로" 같은 요청에 사용한다.
---

# 바이럴 숏폼 제작 풀엔진

주제 한 줄을 넣으면 아래 전 과정을 자동으로 돌려 **완성된 9:16 MP4**를 만든다.

```
주제 → 6장면 B급 대본 + SFX/BGM 타임라인   (배포된 /api/shorts/storyboard)
     → 장면 이미지 6장 (Flux 1.1 Pro, 9:16) (배포된 /api/generate)
     → 장면별 한국어 TTS + 단어별 타이밍      (edge-tts)
     → Ken Burns 줌 + 단어 자막 + SFX + BGM  (MoviePy / FFmpeg)
     → out/<주제>/final.mp4
```

## 설계상 중요한 점
- **캐릭터 일관성은 서버가 강제한다.** 장면별 프롬프트에는 상황만 쓰게 하고, 외모·의상
  시트(`DEFAULT_CHARACTER_SHEET`)와 공통 촬영 규칙을 6개 프롬프트 전부에 서버가 붙인다.
  모델에게 "매번 똑같이 써줘"라고 부탁하는 방식은 실패하기 쉬워서 이렇게 했다.
- **효과음은 고정된 이름 목록에서만 고른다.** 모델이 파일명을 지어내면 매칭이 전부
  실패하기 때문. 목록은 `assets/sfx/README.md` 참고.
- **BGM은 -15dB 자동 감쇄** 후 영상 길이에 맞춰 루프된다(나레이션이 묻히지 않게).
- **자막/카피는 좌우 15%·하단 25% 세이프존을 침범하지 않는다.** 폭을 넘으면 자동
  줄바꿈하고, 그래도 길면 글자 크기를 줄인다.

## 최초 1회 준비
```bash
pip install -r .claude/skills/viral-shorts/requirements.txt
cp .claude/skills/viral-shorts/.env.example .claude/skills/viral-shorts/.env
```
`.env`에 초대받은 계정의 이메일/비밀번호를 채운다(Supabase 값은 저장소의 `.env.local`에서
자동으로 읽어오므로 비워둬도 됨). FFmpeg는 `imageio-ffmpeg`가 번들로 가져오므로 따로
설치할 필요가 없다.

효과음·배경음악은 저작권 때문에 저장소에 포함하지 않았다. `assets/sfx/`, `assets/bgm/`의
README에 적힌 이름으로 mp3를 넣어두면 자동으로 쓰이고, 없으면 그 부분만 건너뛴다.

## 실행 명령
```bash
python .claude/skills/viral-shorts/build_shorts.py --topic "$ARG_TOPIC"
```

웹 화면(`/shorts`)에서 내 이미지를 올려 만든 프로젝트 파일로 영상만 뽑을 때 — 이미지가
이미 있으므로 생성 비용이 들지 않는다:
```bash
python .claude/skills/viral-shorts/build_shorts.py --project shorts-project.json
```

대본·이미지·음성까지만 만들어 먼저 검토하고 싶을 때:
```bash
python .claude/skills/viral-shorts/build_shorts.py --topic "$ARG_TOPIC" --skip-video
```

이미 만든 스토리보드로 영상만 다시 뽑을 때:
```bash
python .claude/skills/viral-shorts/build_shorts.py --storyboard out/<폴더>/storyboard.json
```

기타 옵션: `--out-dir`(저장 폴더, 기본 `./out`) · `--voice`(edge-tts 음성, 기본
`ko-KR-SunHiNeural`).

## 결과물
```
out/<주제 슬러그>/
├── storyboard.json   # 6장면 대본·이미지프롬프트·MJ용 프롬프트·SFX·BGM
├── timeline.txt      # [00:00] 장면1 · SFX: boom · 나레이션... 형식 타임라인
├── images/           # 장면별 원본 + 1080x1920 보정본
├── audio/            # 장면별 나레이션 mp3
└── final.mp4         # 완성본 (1080x1920, 30fps, H.264/AAC)
```
`storyboard.json`의 `midjourneyPrompt`에는 `--ar 9:16 --style raw`가 붙어 있어 미드저니에
그대로 붙여넣어도 된다(Flux/DALL-E용은 `imagePrompt`).

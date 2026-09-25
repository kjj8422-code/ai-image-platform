# 효과음(SFX) 폴더

웹 화면(또는 AI 대본)이 장면마다 아래 **이름 중 하나**를 고르고, 영상 합성 때 같은
이름의 `.mp3`가 그 장면 시작 지점에 깔립니다. 이름·설명 목록은
`src/lib/audioCatalog.json` 한 곳에 있고 웹과 `build_shorts.py`가 같이 읽습니다.

| 파일명 | 느낌 | 출처 |
|---|---|---|
| `boom.mp3` | 쿵! 충격·등장 | Sonniss |
| `suspense.mp3` | 두구두구 긴장 고조 | Sonniss |
| `reveal.mp3` | 짠! 반전 공개 | Sonniss |
| `whoosh.mp3` | 휙 빠른 전환 | Sonniss |
| `pop.mp3` | 뽁 작은 전환 | Sonniss |
| `magic.mp3` | 샤아아~ 마법·판타지 | Sonniss |
| `laugh.mp3` | 피식 코믹 마무리 | Sonniss |
| `coin.mp3` | 띠링 코인·득템 (8비트) | UI SFX arcade/reward |
| `levelup.mp3` | 뾰로롱 레벨업 (8비트) | UI SFX arcade/level-up |
| `fanfare.mp3` | 빰빠밤 축하 (8비트) | UI SFX arcade/achievement |
| `fail.mp3` | 삐빅 실패 (8비트) | UI SFX arcade/error |
| `buzzer.mp3` | 뿌- 안 됨 (8비트) | UI SFX arcade/blocked |
| `boing.mp3` | 띠용 당황 | UI SFX rubber/reaction |
| `impact.mp3` | 둥- 묵직한 한 방 | UI SFX cinematic/start |
| `thud.mp3` | 툭 허탈 | UI SFX cinematic/delete |
| `alarm.mp3` | 경고음 위기 | UI SFX cinematic/warning |
| `triumph.mp3` | 웅장한 성공 | UI SFX cinematic/achievement |
| `ding.mp3` | 딩~ 알림·깨달음 | UI SFX glass/notification |
| `sparkle.mp3` | 반짝반짝 몽환 | UI SFX dreamy/bonus |
| `chime.mp3` | 차라랑 영롱한 성공 | UI SFX glass/achievement |
| `bell.mp3` | 띵~ 종소리 | UI SFX zen/achievement |
| `message.mp3` | 뾱 메시지 도착 | UI SFX scifi/receive |
| `splash.mp3` | 퐁당 물방울 | UI SFX organic/drop |
| `click.mp3` | 철컥 잠금·결심 | UI SFX mechanical/lock |

`my1`~`my3`("내 효과음 1~3")은 기본 파일이 없는 빈 칸입니다. 아래 "직접 넣기"로 채우세요.
AI는 빈 칸을 고르지 않고, 사람이 화면에서 직접 고를 때만 쓰입니다.

## 길이와 음량은 건드릴 필요 없습니다
파일을 그대로 넣으면 됩니다. 합성할 때 자동으로 처리됩니다.

- **길이**: 앞에서 최대 2초만 쓰고 끝을 부드럽게 줄입니다(`SFX_MAX_SECONDS`).
  17초짜리 트레일러 붐을 넣어도 영상 전체에 깔리지 않습니다.
- **음량**: 파일마다 실제 음량을 재서 같은 높이로 맞춥니다(`SFX_TARGET_RMS`).
  녹음 레벨이 제각각인 음원을 섞어 넣어도 나레이션을 덮지 않습니다.

## 라이선스
- **Sonniss** 7개: 2026년 Sonniss GDC Game Audio Bundle(로열티 프리, 출처 표기 불필요).
  `laugh.mp3`는 등장인물 설정에 맞춰 **여성 웃음** 샘플을 골랐습니다.
  > Sonniss 라이선스는 영상·게임 등 **미디어 제작용**만 허용합니다.
  > **AI/머신러닝 학습에 쓰는 것은 금지**되어 있습니다.
- **UI SFX** 17개: npm 패키지 [`uisfx`](https://uisfx.com) 0.4.0의 `sounds/` 폴더.
  **CC0 1.0(퍼블릭 도메인)** — 상업적 이용·수정·재배포 모두 허락 없이 가능, 출처 표기 불필요.

## 직접 넣기 (음원넣기.bat)
Pixabay 효과음, Mixkit 등에서 받은 파일을 **이름 바꿀 필요 없이** 넣을 수 있습니다.

1. 프로젝트 폴더의 `음원넣기.bat`을 더블클릭하거나, 받은 파일을 그 위에 끌어다 놓습니다.
2. 파일을 고르고 → "효과음" → 넣을 칸 번호를 고릅니다.

넣은 파일은 `assets/user/sfx/`에 따로 저장되어 **기본 소리보다 먼저** 쓰입니다(기본
파일은 그대로 남아서 "빼기"로 언제든 되돌릴 수 있습니다). mp3·wav·ogg·m4a 모두 되고,
앞에 붙은 무음은 자동으로 잘라냅니다. 어디서 받았는지는 `assets/user/출처기록.txt`에
남겨 둘 수 있습니다. 크몽 등 상업적 납품에 쓰려면 "상업적 이용 가능" 음원만 쓰세요.


## 확장 팩

원본 합성 효과음 10개와 환경음 6개가 추가되어 기본 제공 소리는 총 40개입니다.
[추가 사운드 팩](../GENERATED_AUDIO.md)에 파일 목록과 생성 방법이 있습니다.
일반 효과음은 장면 시작·중간·끝 중 선택한 위치에, 환경음은 장면 전체에 낮게 깔립니다.

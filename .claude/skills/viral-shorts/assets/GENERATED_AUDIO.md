# 추가 사운드 팩

`generate_audio_pack.py`로 만든 원본 합성 음원입니다. 외부 녹음, 샘플,
기존 곡의 멜로디를 가져오지 않았습니다. 환경음은 실제 현장 녹음이 아닌
노이즈·주파수 합성으로 만든 스타일화된 소리입니다. 기존 음원의 출처는
각 `bgm/README.md`, `sfx/README.md`에 그대로 보존합니다.

## 기본 BGM 11곡 추가 (총 15곡)

| 파일 | 편곡 |
|---|---|
| horror | 느린 불협화 드론 |
| sad | 마이너 피아노 |
| upbeat | 밝은 플럭·팝 드럼 |
| chill | 느슨한 키보드·드럼 |
| action | 빠른 베이스·펄스 |
| retro | 칩튠 아르페지오 |
| warm | 부드러운 어쿠스틱풍 플럭 |
| romantic | 오르골풍 벨 |
| travel | 트로피컬 말렛·퍼커션 |
| documentary | 미니멀 피아노 패턴 |
| inspiring | 패드·상승 선율 |

각 곡은 8마디이며 템포·선율·화성·악기 조합을 다르게 구성했습니다.
영상이 길면 반복합니다. 44.1kHz / 128kbps MP3로 저장합니다.

## 효과음 9개 + 환경음 6개 추가 (총 39개)

효과음: shutter, typing, heartbeat, ticking, riser, downer, swipe,
success, glimmer.

> 정리(2026-09-25): 거의 같은 소리였던 BGM `comedy`(같은 악기·드럼의 upbeat와
> 유사, 용도는 playful과 겹침)와 효과음 `soft_whoosh`(riser를 짧게 자른 것과 같은
> 소리)를 뺐습니다. 예전 프로젝트에 이 이름이 있으면 합성기가 각각 playful,
> whoosh로 대신 재생합니다(build_shorts.py의 RETIRED_BGM / RETIRED_SFX).

환경음: rain, wind, waves, birds, fire, night. 카탈로그의 `playback: bed`가
장면 전체 반복과 낮은 음량을 결정합니다. 일반 효과음은 최대 2초이며
`sfxTiming: start | middle | end`에 따라 장면 안에 배치합니다.
이 필드가 없는 과거 프로젝트는 종전처럼 장면 시작에 재생합니다.

## 적용과 검사

- 웹 배포와 PC의 `업데이트.bat` 실행이 모두 필요합니다. 기존 사용자 음원은
  `assets/user`에 보존되고 기본 파일보다 우선합니다.
- BGM/환경음은 원본 음량을 측정한 후 내레이션 구간에서 추가로 낮춥니다.
  짧은 대사 뒤 사진을 유지하는 구간에서는 서서히 복구하고 영상 끝에서 페이드아웃합니다.
- AI 자동 연출은 생성 시에만 적용합니다. 사용자가 고른 소리·타이밍은
  렌더링 시 자동 선택 규칙으로 덮어쓰지 않습니다.
- 재생성: `python .claude/skills/viral-shorts/generate_audio_pack.py`
- 믹서 검사: `python .claude/skills/viral-shorts/test_audio_mix.py`
- 카탈로그/자동 연출 검사: `npm test`

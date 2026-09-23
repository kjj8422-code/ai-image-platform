# 이 저장소에서 일할 때의 규칙

## 돈이 드는 작업은 반드시 먼저 물어본다

아래 작업은 **실제 비용이 발생**한다. 사용자의 명시적 허락 없이는 절대 실행하지 않는다.
"효율적일 것 같아서", "어차피 필요하니까" 같은 판단으로 앞서 나가지 않는다.

- **Higgsfield 크레딧** — MCP의 `generate_image` / `generate_video` / `generate_audio` /
  `generate_3d` / `upscale_*` / `dubbing` / Marketing Studio / Soul 학습 등 생성 계열 전부.
  조회 계열(`list_workspaces`, `show_generations`, `balance`)은 무료라 그냥 써도 된다.
- **Anthropic API** — `ANTHROPIC_API_KEY`를 쓰는 호출 (`/api/shorts/from-images` 등).
- **Replicate** — `REPLICATE_API_TOKEN`을 쓰는 이미지 생성·인페인팅·배경제거 전부.
- **Runway** — `RUNWAYML_API_SECRET`을 쓰는 AI 영상 쇼츠의 실제 영상 생성. 서버에
  `VIDEO_PROVIDER=runway`가 켜져 있을 때만 실제로 호출된다(기본값은 항상 mock,
  비용 0원 — `src/lib/videoProvider.ts` 참고). 이 환경변수를 켜는 것 자체도 먼저 물어본다.

물어볼 때는 **무엇을 몇 번 호출해서 대략 얼마가 드는지**를 같이 알려준다.
사용자가 "해줘"라고 답한 그 작업 한 번에 대해서만 허락된 것으로 본다 —
다음 번에 또 쓰려면 다시 물어본다.

## 비밀키는 절대 커밋하지 않는다

`.env.local`, `.env`는 `.gitignore`에 있다. 실제 키 값을 코드·문서·커밋 메시지에
적지 않는다. 키가 필요하면 환경변수 이름만 언급한다.

@AGENTS.md

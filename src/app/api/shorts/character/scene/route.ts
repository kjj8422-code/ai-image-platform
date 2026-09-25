import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";
import {
  craftScenePrompt,
  getCharacterImageProvider,
  persistCharacterSceneImage,
  REAL_CHARACTER_PROVIDER_NAME,
  SCENE_MAX,
  SCENE_MIN,
  type SceneStyle,
} from "@/lib/characterShorts";
import { PREVIEW_SFX_CUES } from "@/lib/audioCatalog";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

export const maxDuration = 60;

const SCENE_STYLES: readonly SceneStyle[] = ["comic", "jeju_travel", "emotional", "product_ad"];
const isSceneStyle = (v: unknown): v is SceneStyle =>
  typeof v === "string" && (SCENE_STYLES as readonly string[]).includes(v);

// "사진 1장 + 내 대본" 기능의 장면 하나를 만든다. 화면에서 장면마다(또는 전체 순차
// 루프로) 이 라우트를 호출한다 — AI 영상 쇼츠와 같은 이유로 한 번의 큰 서버 호출
// 대신 장면 단위로 쪼갰다(Vercel 함수 시간 제한, 장면별 mock/real 선택 자유도).
// 이 기능은 DB에 저장하지 않는다(사진 쇼츠와 같은 방식) — 화면에서 만든 장면들을
// 모아 프로젝트 파일로 내려받아 build_shorts.py --project로 최종 렌더링한다.
export async function POST(request: NextRequest) {
  try {
    if (!replicateApiToken) {
      return NextResponse.json(
        { error: "서버 설정 오류: Replicate 토큰이 누락되었습니다." },
        { status: 500 },
      );
    }

    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const referenceImageUrl =
      typeof body?.referenceImageUrl === "string" ? body.referenceImageUrl : "";
    const narration = typeof body?.narration === "string" ? body.narration.trim() : "";
    const style = isSceneStyle(body?.style) ? body.style : "comic";
    const sceneIndex = Number(body?.sceneIndex);
    const totalScenes = Number(body?.totalScenes);
    const provider = body?.provider === "real" ? "real" : "mock";
    const previousSummary =
      typeof body?.previousSummary === "string" ? body.previousSummary.trim().slice(0, 2000) : "";

    if (!referenceImageUrl || !parseAllowedImageUrl(referenceImageUrl, process.env.NEXT_PUBLIC_SUPABASE_URL)) {
      return NextResponse.json({ error: "허용되지 않은 기준 사진 주소입니다." }, { status: 400 });
    }
    if (!narration) {
      return NextResponse.json({ error: "이 장면의 대본을 입력해주세요." }, { status: 400 });
    }
    if (
      !Number.isInteger(sceneIndex) ||
      sceneIndex < 1 ||
      !Number.isInteger(totalScenes) ||
      totalScenes < SCENE_MIN ||
      totalScenes > SCENE_MAX ||
      sceneIndex > totalScenes
    ) {
      return NextResponse.json({ error: "잘못된 장면 번호입니다." }, { status: 400 });
    }

    const replicate = new Replicate({ auth: replicateApiToken });

    if (provider === "mock") {
      // 무료 미리보기: Claude·Flux 둘 다 호출하지 않는다(비용 0원). 기준 사진을
      // 그대로 돌려주고, 효과음만 순환시켜 실제처럼 장면마다 다르게 보여준다.
      const sfx = PREVIEW_SFX_CUES[(sceneIndex - 1) % PREVIEW_SFX_CUES.length];
      return NextResponse.json({
        imageUrl: referenceImageUrl,
        imagePrompt: `(모의) ${narration}`,
        sfx,
        costCents: 0,
        provider: "mock",
      });
    }

    const crafted = await craftScenePrompt(
      replicate,
      narration,
      style,
      sceneIndex,
      totalScenes,
      previousSummary,
    );
    const imageProvider = getCharacterImageProvider("real", replicate);
    const result = await imageProvider.generate({
      referenceImageUrl,
      prompt: crafted.imagePrompt,
    });
    const imageUrl = await persistCharacterSceneImage(
      auth.user.id,
      `scene-${sceneIndex}`,
      result.providerRawUrl,
    );

    return NextResponse.json({
      imageUrl,
      imagePrompt: crafted.imagePrompt,
      sfx: crafted.sfx,
      costCents: result.costCents,
      provider: REAL_CHARACTER_PROVIDER_NAME,
    });
  } catch (err) {
    console.error("캐릭터 장면 생성 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

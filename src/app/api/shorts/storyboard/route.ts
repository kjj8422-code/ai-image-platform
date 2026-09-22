import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import {
  DEFAULT_CHARACTER_SHEET,
  generateStoryboard,
} from "@/lib/shortsStoryboard";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

export const maxDuration = 60;

// 주제 한 줄 -> 6장면 B급 대본 + 장면별 이미지 프롬프트 + SFX/BGM 타임라인.
// 영상 합성은 로컬 CLI 스킬(.claude/skills/viral-shorts)이 담당하고, 이 라우트는
// "무엇을 만들지"만 결정한다.
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
    const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
    const character =
      typeof body?.character === "string" && body.character.trim()
        ? body.character.trim()
        : DEFAULT_CHARACTER_SHEET;

    if (!topic) {
      return NextResponse.json(
        { error: "영상 주제를 입력해주세요." },
        { status: 400 },
      );
    }

    const replicate = new Replicate({ auth: replicateApiToken });
    const storyboard = await generateStoryboard(replicate, topic, character);

    return NextResponse.json(storyboard);
  } catch (err) {
    console.error("스토리보드 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "스토리보드 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

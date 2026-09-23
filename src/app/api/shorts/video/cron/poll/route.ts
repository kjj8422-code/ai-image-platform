import { NextRequest, NextResponse } from "next/server";
import { listGeneratingScenes } from "@/lib/videoJobs";
import { advanceScene } from "@/lib/videoJobEngine";

export const maxDuration = 60;

// Vercel Cron이 주기적으로 호출하는 백스톱. 사용자가 브라우저를 닫아도 'generating'
// 장면이 계속 진행되게 한다 — 평소엔 GET /jobs/[id]가 화면이 열려있는 동안 폴링
// 역할을 하지만(videoJobEngine.ts 설명), 탭을 닫으면 그 경로가 안 불린다.
//
// vercel.json의 크론 스케줄과 짝을 이룬다. CRON_SECRET 환경변수가 없으면 아무도
// 이 라우트를 못 부르게 막는다(설정 실수로 열어두는 사고 방지).
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "서버 설정 오류: CRON_SECRET이 없습니다." },
      { status: 500 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "인증되지 않은 요청입니다." }, { status: 401 });
  }

  const generating = await listGeneratingScenes();
  const results = await Promise.allSettled(
    generating.map(({ job, scene }) => advanceScene(job, scene)),
  );
  const failed = results.filter((r) => r.status === "rejected").length;

  return NextResponse.json({ checked: generating.length, failed });
}

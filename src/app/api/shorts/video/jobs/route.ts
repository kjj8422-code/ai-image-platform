import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/requireUser";
import { parseAllowedImageUrl } from "@/lib/downloadHosts";
import { MIN_IMAGES, MAX_IMAGES } from "@/lib/shortsFromImages";
import {
  createVideoJob,
  findJobByIdempotencyKey,
  insertScenes,
  updateJob,
  listScenesForJob,
  listJobsForUser,
  listScenesForJobs,
  type VideoStyle,
} from "@/lib/videoJobs";
import {
  getScenePlanner,
  getDefaultScenePlannerName,
  SCENE_DURATION_SECONDS,
  type PlanOptions,
} from "@/lib/videoScenePlanner";
import { getVideoProvider, getDefaultVideoProviderName } from "@/lib/videoProvider";

export const maxDuration = 60;

// "내가 만든 영상 목록" 화면용. 장면을 전부 내려보내면(각각 sourceImageUrl 등
// 포함) 목록 하나 부르는 데 너무 커지므로, 썸네일 1장 + 완성 개수만 계산해서 준다.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const jobs = await listJobsForUser(auth.user.id);
    const scenes = await listScenesForJobs(jobs.map((j) => j.id));
    const scenesByJob = new Map<string, typeof scenes>();
    for (const scene of scenes) {
      const list = scenesByJob.get(scene.jobId) ?? [];
      list.push(scene);
      scenesByJob.set(scene.jobId, list);
    }

    const summaries = jobs.map((job) => {
      const jobScenes = (scenesByJob.get(job.id) ?? []).sort(
        (a, b) => a.sceneIndex - b.sceneIndex,
      );
      const first = jobScenes[0];
      return {
        ...job,
        sceneCount: jobScenes.length,
        readySceneCount: jobScenes.filter((s) => s.status === "ready").length,
        thumbnailUrl: first ? (first.videoUrl ?? first.sourceImageUrl) : null,
      };
    });

    return NextResponse.json({ jobs: summaries });
  } catch (err) {
    console.error("AI 영상 쇼츠 작업 목록 조회 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const VIDEO_STYLES: readonly VideoStyle[] = [
  "comic",
  "jeju_travel",
  "emotional",
  "product_ad",
];
const isVideoStyle = (v: unknown): v is VideoStyle =>
  typeof v === "string" && (VIDEO_STYLES as readonly string[]).includes(v);

// AI 영상 쇼츠 작업을 만든다: 이미지 묶음 -> (Claude 또는 mock으로) 장면 계획 ->
// video_jobs/video_scenes에 저장. 이 라우트가 끝나면 job은 'reviewable' 상태가
// 되고, 실제 영상 생성(비용 발생)은 장면별로 /scenes/[i]/generate를 따로 호출해야
// 시작된다 — 계획을 세우는 것과 돈을 쓰는 것을 분리했다.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const rawUrls: unknown = body?.imageUrls;
    const imageUrls = Array.isArray(rawUrls)
      ? rawUrls.filter((url): url is string => typeof url === "string")
      : [];
    const idempotencyKey: unknown = body?.idempotencyKey;
    const keepOrder = body?.keepOrder === true;
    const useAllImages = body?.useAllImages === true;
    const style = isVideoStyle(body?.style) ? body.style : "comic";
    const narrationEnabled = body?.narrationEnabled !== false;
    const subtitleEnabled = body?.subtitleEnabled !== false;

    if (imageUrls.length < MIN_IMAGES || imageUrls.length > MAX_IMAGES) {
      return NextResponse.json(
        { error: `이미지를 ${MIN_IMAGES}~${MAX_IMAGES}장 올려주세요.` },
        { status: 400 },
      );
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return NextResponse.json(
        { error: "idempotencyKey가 필요합니다." },
        { status: 400 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const allowed = imageUrls.every((url) =>
      Boolean(parseAllowedImageUrl(url, supabaseUrl)),
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "허용되지 않은 이미지 주소가 포함되어 있습니다." },
        { status: 400 },
      );
    }

    // 같은 요청이 중복 제출돼도(더블클릭, 새로고침 재전송) 새 작업을 만들지 않고
    // 기존 작업을 그대로 돌려준다.
    const existing = await findJobByIdempotencyKey(auth.user.id, idempotencyKey);
    if (existing) {
      const scenes = await listScenesForJob(existing.id);
      return NextResponse.json({ job: existing, scenes });
    }

    const job = await createVideoJob({
      userId: auth.user.id,
      idempotencyKey,
      sourceImageUrls: imageUrls,
      keepOrder,
      useAllImages,
      style,
      narrationEnabled,
      subtitleEnabled,
    });

    const options: PlanOptions = {
      keepOrder,
      useAllImages,
      style,
      narrationEnabled,
      subtitleEnabled,
    };

    try {
      await updateJob(job.id, { status: "planning" });

      const planner = getScenePlanner(getDefaultScenePlannerName());
      const plan = await planner.plan(imageUrls, options);

      const providerName = getDefaultVideoProviderName();
      const provider = getVideoProvider(providerName);
      const estimatedCostCents = plan.scenes.reduce(
        (sum) => sum + provider.estimateCostCents(SCENE_DURATION_SECONDS),
        0,
      );

      await insertScenes(
        plan.scenes.map((scene, i) => ({
          jobId: job.id,
          sceneIndex: i + 1,
          sourceImageUrl: imageUrls[scene.imageIndex - 1],
          referenceImageUrls: [],
          narration: scene.narration,
          subtitle: scene.subtitle,
          keyAction: scene.keyAction,
          cameraMotion: scene.cameraMotion,
          preserveNotes: scene.preserveNotes,
          prompt: scene.prompt,
          durationTargetSeconds: SCENE_DURATION_SECONDS,
        })),
      );

      // v1 단순화: 예산 상한을 예상 비용과 같게 둔다(장면 재생성으로 무한히
      // 초과 지출되는 걸 막는 기본값). 화면에서 값을 바꾸는 UI는 후속 범위.
      await updateJob(job.id, {
        status: "reviewable",
        provider: providerName,
        estimatedCostCents,
        maxBudgetCents: estimatedCostCents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "장면 계획 생성 실패";
      await updateJob(job.id, { status: "failed", error: message });
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const scenes = await listScenesForJob(job.id);
    const finalJob = await findJobByIdempotencyKey(auth.user.id, idempotencyKey);
    return NextResponse.json({ job: finalJob, scenes });
  } catch (err) {
    console.error("AI 영상 쇼츠 작업 생성 오류:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

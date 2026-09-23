import RunwayML from "@runwayml/sdk";
import type { ImageToVideoRequest, PollResult, SubmitResult, VideoProvider } from "./videoProvider";

// Runway Gen-4 Turbo로 이미지를 동영상 클립으로 만든다.
// 가격 $0.05/초 = 5 credit/초 (공식 https://docs.dev.runwayml.com/guides/pricing/ 확인함,
// 2026-09-23 기준). 1 credit == $0.01 == 1 cent라 credits 값을 그대로 cent로 쓴다.
//
// 실제로 이 클래스를 쓰려면 RUNWAYML_API_SECRET 환경변수가 필요하다(dev.runwayml.com에서
// 발급). 아직 등록 안 됐고, 이 파일은 코드만 작성한 단계 — 승인 전까지 호출 안 함.
//
// 5초 미만 요청이 와도 Runway 최소 단위(5초/10초)로 반올림한다 — 실제 과금 대상 길이가
// 화면에 보이는 "장면 목표 길이"와 다를 수 있다는 걸 호출부(작업 생성 UI)가 안내해야 한다.
const roundToSupportedDuration = (seconds: number): 5 | 10 =>
  seconds <= 5 ? 5 : 10;

export class RunwayVideoProvider implements VideoProvider {
  readonly name = "runway-gen4-turbo";
  private readonly client: RunwayML;

  constructor(apiKey: string = process.env.RUNWAYML_API_SECRET ?? "") {
    if (!apiKey) {
      throw new Error(
        "RUNWAYML_API_SECRET이 없습니다. dev.runwayml.com에서 키를 발급받아 " +
          "환경변수로 등록해주세요.",
      );
    }
    this.client = new RunwayML({ apiKey });
  }

  estimateCostCents(durationSeconds: number): number {
    return roundToSupportedDuration(durationSeconds) * 5; // 5 credit(=5 cent)/초
  }

  async submit(request: ImageToVideoRequest): Promise<SubmitResult> {
    const duration = roundToSupportedDuration(request.durationSeconds);

    // 참조 이미지(캐릭터 일관성)는 Runway image_to_video API 자체의 다중 참조 여부가
    // 공식 문서로 확인 안 됐다 — 일단 메인 이미지만 promptImage로 보낸다.
    // referenceImageUrls는 받아만 두고 아직 안 씀(후속 조사 대상, videoProvider.ts 참고).
    const task = await this.client.imageToVideo.create({
      model: "gen4_turbo",
      promptImage: request.sourceImageUrl,
      promptText: request.prompt,
      ratio: "720:1280", // 9:16 세로 (공식 문서 확인된 프리셋)
      duration,
    });

    return {
      providerJobId: task.id,
      providerModel: "gen4_turbo",
      estimatedCostCents: this.estimateCostCents(request.durationSeconds),
    };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    // "5초에 한 번 이상 자주 조회하지 말 것"이 공식 문서 안내 — 호출부(잡 워커)가
    // 이 간격을 지켜야 한다. 여기서는 조회 한 번만 한다.
    const task = await this.client.tasks.retrieve(providerJobId);

    switch (task.status) {
      case "PENDING":
      case "THROTTLED":
        return { status: "generating" };
      case "RUNNING":
        return { status: "generating", progress: task.progress };
      case "SUCCEEDED": {
        const videoUrl = task.output[0];
        if (!videoUrl) {
          return { status: "failed", error: "결과 URL이 비어있습니다.", charged: true };
        }
        // 주의: 이 URL은 24~48시간 뒤 만료된다(공식 문서). 호출부가 즉시 다운로드해
        // Supabase Storage로 옮겨야 한다 — provider_raw_url에 그대로 보관하지 말 것.
        return { status: "ready", videoUrl, actualCostCents: task.cost.credits };
      }
      case "FAILED":
        // cost.credits가 0이면 전액 환불됨(공식 문서: "Fully refunded tasks report 0").
        return {
          status: "failed",
          error: task.failure,
          charged: task.cost.credits > 0,
        };
      case "CANCELLED":
        return { status: "failed", error: "작업이 취소되었습니다.", charged: task.cost.credits > 0 };
      default:
        // 위 6개가 SDK가 정의한 전부다 — 여기 도달하면 SDK가 새 상태를 추가한 것.
        return { status: "failed", error: "알 수 없는 작업 상태입니다.", charged: false };
    }
  }
}

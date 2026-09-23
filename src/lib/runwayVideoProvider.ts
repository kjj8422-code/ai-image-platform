import RunwayML from "@runwayml/sdk";
import type { ImageToVideoRequest, PollResult, SubmitResult, VideoProvider } from "./videoProvider";

// Runway Gen-4 Turbo로 이미지를 동영상 클립으로 만든다.
// 가격: 초당 5 credit, 최소 10 credit(=2초 미만이어도 2초치 청구) — dev.runwayml.com의
// image_to_video 플레이그라운드(modelId=gen4_turbo)에서 직접 확인함, 2026-09-23 기준.
// 1 credit == $0.01 == 1 cent라 credits 값을 그대로 cent로 쓴다.
//
// 실제로 이 클래스를 쓰려면 RUNWAYML_API_SECRET 환경변수가 필요하다(dev.runwayml.com에서
// 발급).
//
// 지원 길이는 2~10초의 정수 초 단위다(같은 플레이그라운드의 Duration 드롭다운에서 확인:
// 2,3,4,5,6,7,8,9,10초 전부 선택 가능 — "5초/10초 중 하나만 된다"는 예전 가정은 틀렸다).
const clampToSupportedDuration = (seconds: number): number =>
  Math.min(10, Math.max(2, Math.round(seconds)));

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
    return Math.max(10, clampToSupportedDuration(durationSeconds) * 5); // 최소 10 credit
  }

  async submit(request: ImageToVideoRequest): Promise<SubmitResult> {
    const duration = clampToSupportedDuration(request.durationSeconds);

    // 참조 이미지(캐릭터 일관성) 미지원을 SDK 타입 정의로 확인함: gen4_turbo의
    // promptImage는 배열을 받을 수는 있지만 각 원소의 position이 'first' 하나뿐이라
    // "여러 시작 프레임 후보"가 아니라 사실상 이미지 1장용이다. 진짜 다중 참조가
    // 필요하면 이 공급자로는 안 되고 다른 모델(예: Veo3.1 first+last)을 봐야 한다.
    // referenceImageUrls는 그래서 여기선 그냥 버려진다 — 후속 조사 대상.
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

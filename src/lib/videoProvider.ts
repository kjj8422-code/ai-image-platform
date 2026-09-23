// 이미지 1장을 짧은 동영상 클립으로 만드는 외부 API를 추상화한다.
// 공급자(Runway/Kling/Replicate 등)를 나중에 골라도 이 인터페이스만 구현하면
// 호출부(job 처리 로직)는 안 바뀐다. 아직 실제 공급자는 연결 안 함 — MockVideoProvider만
// 존재하며, 모의 테스트용이다. 승인 전까지는 어떤 실제 공급자도 여기 추가하지 않는다.

export type ImageToVideoRequest = {
  sourceImageUrl: string;
  referenceImageUrls: string[];
  prompt: string;
  durationSeconds: number;
  aspectRatio: "9:16";
};

export type SubmitResult = {
  providerJobId: string;
  providerModel: string;
  estimatedCostCents: number;
};

export type PollResult =
  // progress는 공급자가 실제로 알려주는 값만 넣는다(모르면 undefined) — 가짜 퍼센트 금지.
  | { status: "generating"; progress?: number }
  | { status: "ready"; videoUrl: string; actualCostCents: number }
  | { status: "failed"; error: string; charged: boolean };

// 공급자가 실제로 구현해야 하는 최소 계약. 웹훅을 지원하는 공급자도 결국
// "완료됐는지 확인"이 필요하므로 poll을 기본으로 하고, 웹훅은 poll을 더 일찍
// 트리거하는 최적화로만 취급한다(웹훅 미지원 공급자에서도 같은 코드가 동작해야 함).
export interface VideoProvider {
  readonly name: string;
  submit(request: ImageToVideoRequest): Promise<SubmitResult>;
  poll(providerJobId: string): Promise<PollResult>;
}

// 실제 공급자 연결 전, DB 스키마·job 처리 로직·화면을 끝까지 이어서 테스트하기 위한
// 가짜 구현. 비용이 전혀 들지 않는다. 2~3초 뒤 "성공"을 돌려준다.
export class MockVideoProvider implements VideoProvider {
  readonly name = "mock";
  private readonly jobs = new Map<string, number>(); // providerJobId -> 제출 시각(ms)

  async submit(request: ImageToVideoRequest): Promise<SubmitResult> {
    const providerJobId = `mock_${Math.random().toString(36).slice(2)}`;
    this.jobs.set(providerJobId, Date.now());
    return {
      providerJobId,
      providerModel: "mock-echo-v0",
      // 실제 가격이 아니다 — 모의 테스트에서 "예상 비용 표시 UI"를 확인하기 위한 값.
      estimatedCostCents: Math.round(request.durationSeconds * 5),
    };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    const submittedAt = this.jobs.get(providerJobId);
    if (!submittedAt) {
      return { status: "failed", error: "알 수 없는 작업 ID입니다.", charged: false };
    }
    if (Date.now() - submittedAt < 3000) {
      return { status: "generating" };
    }
    // 원본 이미지를 그대로 "생성된 영상"인 것처럼 돌려준다 — 실제 동영상이 아니라
    // 파이프라인(상태 전이, 다운로드, 화면 표시) 검증용이다.
    return {
      status: "ready",
      videoUrl: "https://placehold.co/1080x1920.png?text=mock+clip",
      actualCostCents: 25,
    };
  }
}

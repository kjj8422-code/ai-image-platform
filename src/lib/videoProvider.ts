import { RunwayVideoProvider } from "./runwayVideoProvider";

// 이미지 1장을 짧은 동영상 클립으로 만드는 외부 API를 추상화한다.
// 공급자(Runway/Kling/Replicate 등)를 나중에 골라도 이 인터페이스만 구현하면
// 호출부(job 처리 로직)는 안 바뀐다.
//
// 기본 공급자는 항상 mock이다(getDefaultVideoProviderName). Runway가 코드로는
// 연결돼 있어도, 서버에 VIDEO_PROVIDER=runway 환경변수를 직접 켜기 전까지는
// 어떤 요청도 실제로 Runway에 닿지 않는다 — 실수로 과금되는 걸 막기 위한 장치다.

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
  // 실제로 제출하지 않고 가격만 계산한다 — "생성 전에 예상 비용을 보여준다"를
  // 지키려면 순수 계산(네트워크 호출 없음)이어야 한다. submit() 내부에서도 이걸 쓴다.
  estimateCostCents(durationSeconds: number): number;
  submit(request: ImageToVideoRequest): Promise<SubmitResult>;
  poll(providerJobId: string): Promise<PollResult>;
}

// 실제 공급자 연결 전, DB 스키마·job 처리 로직·화면을 끝까지 이어서 테스트하기 위한
// 가짜 구현. 비용이 전혀 들지 않는다. 제출 3초 뒤 "성공"을 돌려준다.
//
// Vercel 서버리스 함수는 요청마다 새 인스턴스일 수 있어 인스턴스 메모리(Map 등)에
// 상태를 못 둔다 — submit과 poll이 다른 인스턴스에서 실행되면 그 상태가 사라진다.
// 그래서 제출 시각을 providerJobId 문자열 자체에 인코딩해 poll이 그걸 다시 읽는다.
export class MockVideoProvider implements VideoProvider {
  readonly name = "mock";

  estimateCostCents(durationSeconds: number): number {
    // 실제 가격이 아니다 — 모의 테스트에서 "예상 비용 표시 UI"를 확인하기 위한 값.
    return Math.round(durationSeconds * 5);
  }

  async submit(request: ImageToVideoRequest): Promise<SubmitResult> {
    const providerJobId = `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return {
      providerJobId,
      providerModel: "mock-echo-v0",
      estimatedCostCents: this.estimateCostCents(request.durationSeconds),
    };
  }

  async poll(providerJobId: string): Promise<PollResult> {
    const submittedAt = Number(providerJobId.split("_")[1]);
    if (!providerJobId.startsWith("mock_") || !Number.isFinite(submittedAt)) {
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

// 공급자 이름 -> 인스턴스. 실제 공급자는 여기서 새 항목만 추가하면 되고,
// 호출부(job 처리 로직·API 라우트)는 전혀 안 바뀐다.
export const getVideoProvider = (name: string): VideoProvider => {
  switch (name) {
    case "mock":
      return new MockVideoProvider();
    case "runway":
      // import는 클래스 정의만 실행한다 — 생성자(키 필요)는 여기서 new할 때만
      // 실행되므로, RUNWAYML_API_SECRET이 없는 환경에서 이 파일을 import하는 것만으로는
      // 에러가 나지 않는다.
      return new RunwayVideoProvider();
    default:
      throw new Error(`알 수 없는 영상 생성 공급자입니다: ${name}`);
  }
};

// 이번 배포에서 새 작업에 실제로 쓸 공급자. 환경변수로만 바뀐다 — 코드를 고치거나
// 배포하지 않고는 실제 공급자로 못 넘어간다(과금 사고 방지). 값을 안 주면 mock.
export const getDefaultVideoProviderName = (): string =>
  process.env.VIDEO_PROVIDER?.trim() || "mock";

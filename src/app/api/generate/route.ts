import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { requireUser } from "@/lib/requireUser";
import {
  enhancePrompt,
  extractImageUrl,
  withRetryOn429,
} from "@/lib/replicateHelpers";
import { DEFAULT_FORMAT_ID, resolveAspectRatio } from "@/lib/imageFormats";

const replicateApiToken = process.env.REPLICATE_API_TOKEN;

// 프롬프트 하나당 몇 장을 생성할지 — 호출부에서 지정하지 않으면 기존 기본값(4장) 유지.
// 쇼츠 썸네일 화면은 반복 생성이 잦아 2장으로 줄여서 호출한다(비용·대기시간 절감).
const DEFAULT_IMAGES_PER_REQUEST = 4;
const MAX_IMAGES_PER_REQUEST = 4;

const resolveImageCount = (value: unknown): number => {
  const parsed = typeof value === "number" ? Math.floor(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_IMAGES_PER_REQUEST;
  }
  return Math.min(parsed, MAX_IMAGES_PER_REQUEST);
};

const containsHangul = (text: string): boolean => /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);

// 썸네일 화면은 이미 완성된 영문 프롬프트(문구 추천 단계에서 만든 것)를 보낸다.
// 그걸 또 보강하면 애써 넣은 구도·인물 지시가 임의로 다시 쓰이고, Claude 호출이
// 한 번 더 들어가 Replicate 순간 속도제한에도 더 자주 걸린다. 그래서 호출부가
// enhance:false를 주면 건너뛴다 — 다만 프롬프트에 한글이 섞여 있으면 번역이
// 반드시 필요하므로 그때는 요청과 무관하게 보강한다.
const shouldEnhancePrompt = (prompt: string, requested: unknown): boolean =>
  requested === false ? containsHangul(prompt) : true;

// 최대 실행 시간을 넉넉히 잡아둔다 (번역 호출 + 이미지 4장 순차 생성 +
// 속도 제한에 걸렸을 때의 재시도 대기 시간까지 합치면 기본 10초로는 부족할 수 있음).
export const maxDuration = 60;

// Flux 1.1 Pro로 이미지 1장을 생성한다. 여러 장을 만들 때 매번 같은 결과가
// 나오지 않도록 매 호출마다 랜덤 시드를 지정한다.
// aspectRatio를 넘겨 납품 규격에 맞는 비율로 바로 생성한다(정사각형을 잘라
// 쓰면 썸네일 규격에 미달하므로).
const generateOneImage = async (
  replicate: Replicate,
  prompt: string,
  aspectRatio: string,
): Promise<string> => {
  const output = await withRetryOn429(() =>
    replicate.run("black-forest-labs/flux-1.1-pro", {
      input: {
        prompt,
        aspect_ratio: aspectRatio,
        seed: Math.floor(Math.random() * 1_000_000),
      },
    }),
  );

  return extractImageUrl(output);
};

// 개인/초대 전용 도구 — 로그인만 확인하면 크레딧 차감 없이 자유롭게 생성한다.
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
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return NextResponse.json(
        { error: "프롬프트를 입력해주세요." },
        { status: 400 },
      );
    }

    // 규격을 지정하지 않으면 가장 많이 쓰는 썸네일 비율로 생성한다.
    const aspectRatio = resolveAspectRatio(body?.format ?? DEFAULT_FORMAT_ID);
    if (!aspectRatio) {
      return NextResponse.json(
        { error: "지원하지 않는 규격입니다." },
        { status: 400 },
      );
    }

    const imageCount = resolveImageCount(body?.count);

    const replicate = new Replicate({ auth: replicateApiToken });

    // 프롬프트 자동 번역·보강 (한글 등 비영어 입력도 Flux가 정확히 이해하도록)
    const enhancedPrompt = shouldEnhancePrompt(prompt, body?.enhance)
      ? await enhancePrompt(replicate, prompt)
      : prompt;

    // Flux 1.1 Pro로 이미지 여러 장을 생성 — 품질 정책상 항상 Pro 모델만 사용.
    // Replicate의 "한 번에 1개 요청" 속도 제한 때문에 동시(병렬) 호출이 아니라
    // 하나씩 순차적으로 생성한다.
    const imageUrls: string[] = [];
    for (let i = 0; i < imageCount; i += 1) {
      imageUrls.push(
        await generateOneImage(replicate, enhancedPrompt, aspectRatio),
      );
    }

    return NextResponse.json({ imageUrls, enhancedPrompt });
  } catch (err) {
    console.error("이미지 생성 오류:", err);
    const message =
      err instanceof Error
        ? err.message
        : "이미지 생성 중 알 수 없는 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

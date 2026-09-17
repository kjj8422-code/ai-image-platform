"use client";

import { supabase } from "@/lib/supabase";

// 이미지를 실제로 "저장"시킨다.
//
// 원본 주소를 <a download>로 바로 걸면 다른 도메인이라 저장되지 않고 새 탭에서
// 열려버린다. 그래서 우리 서버(/api/download)를 거쳐 받은 뒤, 브라우저 메모리
// 안의 파일(blob)로 만들어 내려준다. 이러면 PC·휴대폰 모두 저장으로 동작한다.
export const downloadImage = async (imageUrl: string): Promise<void> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("로그인이 필요합니다.");
  }

  const response = await fetch(
    `/api/download?url=${encodeURIComponent(imageUrl)}`,
    { headers: { Authorization: `Bearer ${session.access_token}` } },
  );

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error ?? "다운로드에 실패했습니다.");
  }

  // 서버가 붙여준 파일 이름을 그대로 쓴다.
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName =
    /filename="([^"]+)"/.exec(disposition)?.[1] ?? "ai-image.png";

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // 만든 임시 주소를 정리하지 않으면 메모리에 계속 남는다.
  URL.revokeObjectURL(objectUrl);
};

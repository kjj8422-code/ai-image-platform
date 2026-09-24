// 서버 응답을 JSON으로 읽는다. 읽을 수 없으면 원인을 알 수 있는 한국어 오류로 바꾼다.
//
// 우리 API는 항상 JSON을 돌려주지만, 그 앞단(Vercel)이 대신 답하는 경우가 있다 —
// 시간 초과(504), 요청이 너무 큼(413) 등. 이때는 평문/HTML이 와서 response.json()이
// "Unexpected token 'A'..." 같은 영어 오류로 터지고, 화면만 봐서는 무슨 일인지 모른다.
const statusMessage = (status: number): string => {
  if (status === 504 || status === 408) {
    return "서버가 너무 오래 걸려서 중간에 끊겼어요. 잠시 후 다시 시도해 주세요.";
  }
  if (status === 413) {
    return "보낸 파일이 너무 커요. 사진 수를 줄이거나 더 작은 사진으로 다시 시도해 주세요.";
  }
  if (status === 429) {
    return "요청이 몰려서 잠깐 막혔어요. 30초쯤 뒤에 다시 시도해 주세요.";
  }
  if (status >= 500) {
    return `서버에 문제가 생겼어요 (오류 ${status}). 잠시 후 다시 시도해 주세요.`;
  }
  return `서버에서 알 수 없는 응답이 왔어요 (오류 ${status}).`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response.json()과 같은 계약
export const readJson = async (response: Response): Promise<any> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(statusMessage(response.status));
  }
};

export async function validateBrowserClip(file: File): Promise<void> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...header.slice(4,8)) !== "ftyp") throw new Error("MP4 형식의 영상 파일을 선택하세요.");
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("영상 정보를 읽지 못했습니다. H.264 MP4로 저장해 주세요.")), 15000);
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) reject(new Error("재생 가능한 MP4 영상이 아닙니다."));
        else resolve();
      };
      video.onerror = () => { clearTimeout(timer); reject(new Error("이 브라우저가 재생할 수 없는 영상입니다. H.264 MP4를 사용하세요.")); };
      video.src = url;
    });
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

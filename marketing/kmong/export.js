// 렌더된 PNG를 크몽 업로드용 JPG와, 포트폴리오 제출용 통합 PDF로 내보낸다.
// JPG: 크몽 이미지 업로드용(용량이 PNG보다 작아 업로드 제한에 안 걸림)
// PDF: 5장을 한 파일로 묶어 제출·전달용
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SALES = [
  "01-cover",
  "02-quality",
  "03-retouch",
  "04-scope",
  "05-package",
  "06-process",
];
const MOCKS = [
  { name: "mock-thumb", w: 1280, h: 720 },
  { name: "mock-detail", w: 860, h: 1075 },
  { name: "mock-banner", w: 1200, h: 400 },
];

const main = async () => {
  fs.mkdirSync("out/jpg", { recursive: true });

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });

  // 1) HTML을 직접 JPG로 재렌더링한다(PNG를 다시 압축하는 것보다 선명하다).
  const toJpg = async (file, w, h) => {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      deviceScaleFactor: 2,
    });
    await page.goto("file://" + path.resolve(`${file}.html`));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `out/jpg/${file}.jpg`,
      type: "jpeg",
      quality: 92,
    });
    await page.close();
    const kb = Math.round(fs.statSync(`out/jpg/${file}.jpg`).size / 1024);
    console.log(`  ${file}.jpg  ${w * 2}x${h * 2}  ${kb}KB`);
  };

  console.log(`JPG 변환 (판매 이미지 ${SALES.length}종):`);
  for (const name of SALES) {
    await toJpg(name, 1200, 900);
  }
  console.log("JPG 변환 (목업 3종):");
  for (const m of MOCKS) {
    await toJpg(m.name, m.w, m.h);
  }

  // 2) 판매 이미지 5장을 한 PDF로 묶는다. 이미지 비율(4:3)에 페이지를 맞춰
  //    위아래 여백 없이 꽉 차게 만든다.
  const pages = SALES.map(
    (name) =>
      `<div class="pg"><img src="${path.resolve(`out/jpg/${name}.jpg`)}"></div>`,
  ).join("\n");

  const pdfHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 1200px 900px; margin: 0 }
    *{margin:0;padding:0}
    html,body{background:#000}
    .pg{width:1200px;height:900px;overflow:hidden;page-break-after:always;
        display:block;line-height:0}
    .pg:last-child{page-break-after:auto}
    .pg img{width:1200px;height:900px;display:block}
  </style></head><body>${pages}</body></html>`;

  fs.writeFileSync("out/_pdf.html", pdfHtml);

  const pdfPage = await browser.newPage();
  await pdfPage.goto("file://" + path.resolve("out/_pdf.html"));
  await pdfPage.pdf({
    path: "out/kmong-portfolio.pdf",
    width: "1200px",
    height: "900px",
    printBackground: true,
    pageRanges: `1-${SALES.length}`,
  });
  await pdfPage.close();
  fs.unlinkSync("out/_pdf.html");

  const pdfKb = Math.round(fs.statSync("out/kmong-portfolio.pdf").size / 1024);
  console.log(`PDF: out/kmong-portfolio.pdf  ${SALES.length}페이지  ${pdfKb}KB`);

  await browser.close();
};

main();

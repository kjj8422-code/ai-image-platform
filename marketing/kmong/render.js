// HTML 5종을 2배 해상도 PNG로 렌더링하고, 내용이 캔버스(1200x900) 밖으로
// 삐져나갔는지 실제 좌표로 검증한다. 눈대중 대신 수치로 잡기 위한 도구.
const { chromium } = require("playwright");
const path = require("path");

const W = 1200;
const H = 900;
const TOL = 0.6; // 서브픽셀 반올림 허용 오차

const main = async () => {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("사용법: node render.js <파일.html> ...");
    process.exit(1);
  }

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });
  let failed = 0;

  for (const file of files) {
    // 캔버스 크기는 HTML이 <meta name="canvas" content="1280x720">로 선언한다.
    // 선언이 없으면 판매 이미지 기본값(1200x900)을 쓴다.
    const probe = await browser.newPage();
    await probe.goto("file://" + path.resolve(file));
    const declared = await probe.evaluate(
      () => document.querySelector('meta[name="canvas"]')?.content ?? "",
    );
    await probe.close();

    const [w, h] = declared.match(/^\d+x\d+$/)
      ? declared.split("x").map(Number)
      : [W, H];

    const page = await browser.newPage({
      viewport: { width: w, height: h },
      deviceScaleFactor: 2,
    });
    await page.goto("file://" + path.resolve(file));
    await page.evaluate(() => document.fonts.ready);

    const report = await page.evaluate(
      ({ W, H, TOL }) => {
        const issues = [];
        const stage = document.querySelector(".stage");
        if (stage) {
          const r = stage.getBoundingClientRect();
          if (Math.abs(r.width - W) > TOL || Math.abs(r.height - H) > TOL) {
            issues.push(`stage 크기 ${Math.round(r.width)}x${Math.round(r.height)} (기대 ${W}x${H})`);
          }
        }

        // 글자가 있는 말단 요소만 검사한다(컨테이너는 자식으로 이미 판정됨).
        const leaves = [...document.querySelectorAll(".pad *")].filter((el) => {
          if (!el.textContent.trim()) return false;
          return ![...el.children].some((c) => c.textContent.trim());
        });

        for (const el of leaves) {
          const r = el.getBoundingClientRect();
          const label = `${el.className || el.tagName}: "${el.textContent.trim().slice(0, 24)}"`;
          if (r.bottom > H + TOL) issues.push(`아래 넘침 ${(r.bottom - H).toFixed(0)}px — ${label}`);
          if (r.top < -TOL) issues.push(`위 넘침 ${(-r.top).toFixed(0)}px — ${label}`);
          if (r.right > W + TOL) issues.push(`오른쪽 넘침 ${(r.right - W).toFixed(0)}px — ${label}`);
          if (r.left < -TOL) issues.push(`왼쪽 넘침 ${(-r.left).toFixed(0)}px — ${label}`);
        }

        // 카드 안에서 내용이 잘리는 경우(스크롤 발생)도 잡는다.
        for (const el of document.querySelectorAll(".pad *")) {
          // data-clip: 목업을 transform으로 축소해 끼운 자리. transform은 레이아웃
          // 크기를 바꾸지 않아 항상 넘침으로 잡히므로 검사에서 제외한다.
          if (el.hasAttribute("data-clip") || el.closest("[data-clip]")) continue;
          if (el.scrollHeight - el.clientHeight > 1 && getComputedStyle(el).overflow !== "visible") {
            issues.push(`내부 잘림 ${el.scrollHeight - el.clientHeight}px — ${el.className}`);
          }
        }
        return issues;
      },
      { W: w, H: h, TOL },
    );

    const name = path.basename(file, ".html");
    await page.screenshot({ path: `out/${name}.png` });

    await page.close();

    if (report.length) {
      failed += 1;
      console.log(`[문제] ${name}`);
      [...new Set(report)].forEach((m) => console.log(`   - ${m}`));
    } else {
      console.log(`[정상] ${name}.png  ${w * 2}x${h * 2}`);
    }
  }

  await browser.close();
  process.exit(failed ? 1 : 0);
};

main();

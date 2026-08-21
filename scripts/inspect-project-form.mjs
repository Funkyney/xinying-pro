import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(process.env.XINYING_CDP_PORT ?? 9333)}`);
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("blueaivideo.com"));
  if (!page) throw new Error("找不到心影页面");
  const state = await page.evaluate(() => ({
    url: location.href,
    trigger: document.querySelector(".selector-trigger")?.textContent?.replace(/\s+/g, " ").trim(),
    dialogs: [...document.querySelectorAll(".el-dialog")]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => element.textContent?.replace(/\s+/g, " ").trim()),
    inputs: [...document.querySelectorAll(".el-dialog input")].map((element) => ({
      placeholder: element.getAttribute("placeholder"),
      role: element.getAttribute("role"),
      value: element.value,
      controls: element.getAttribute("aria-controls"),
    })),
    visibleOptions: [...document.querySelectorAll("[role='option']")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => element.textContent?.trim()),
  }));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} finally {
  await browser.close();
}

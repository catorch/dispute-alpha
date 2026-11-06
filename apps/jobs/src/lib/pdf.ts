import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { Env } from "../env";
import { FOOTER } from "./letters";

export type RenderSession = { render(html: string): Promise<Uint8Array>; close(): Promise<void> };

/**
 * Opens one Browser Run session for a whole queue batch (R15.4). Reuses an idle session when one
 * exists to avoid start-up time; the page loads no remote URLs and runs no JavaScript (R15.1).
 */
export async function openBrowserRenderer(env: Env): Promise<RenderSession> {
  if (!env.BROWSER) throw new Error("BROWSER binding missing");
  const endpoint = env.BROWSER as unknown as BrowserWorker;
  const idle = (await puppeteer.sessions(endpoint).catch(() => [])).find((s) => !s.connectionId);
  const browser = idle ? await puppeteer.connect(endpoint, idle.sessionId).catch(() => puppeteer.launch(endpoint, { keep_alive: 120_000 })) : await puppeteer.launch(endpoint, { keep_alive: 120_000 });
  return {
    async render(html) {
      const page = await browser.newPage();
      try {
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (r) => {
          const u = r.url();
          if (u.startsWith("data:") || u === "about:blank") r.continue();
          else r.abort();
        });
        await page.setContent(html, { waitUntil: "load" });
        const pdf = await page.pdf({
          format: "letter",
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: "<div></div>",
          footerTemplate: FOOTER,
          margin: { top: "1in", right: "1in", bottom: "1in", left: "1in" },
        });
        return new Uint8Array(pdf);
      } finally {
        await page.close().catch(() => {});
      }
    },
    // Disconnect rather than close, so the session stays warm for the next batch.
    close: () => browser.disconnect(),
  };
}

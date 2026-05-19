import { chromium, BrowserContext } from "playwright";
import path from "path";
import { logger } from "./logger";

const USER_DATA_DIR = path.join(process.cwd(), ".browser-data");

let _context: BrowserContext | null = null;
let _launching: Promise<BrowserContext> | null = null;

export async function getBrowserContext(): Promise<BrowserContext> {
  if (_context) {
    try {
      _context.pages();
      return _context;
    } catch {
      _context = null;
      _launching = null;
    }
  }

  if (_launching) return _launching;

  logger.info("Launching persistent browser context");

  _launching = chromium
    .launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/New_York",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    })
    .then(async (ctx) => {
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
        });
      });

      _context = ctx;
      logger.info("Browser context ready");
      return ctx;
    });

  return _launching;
}

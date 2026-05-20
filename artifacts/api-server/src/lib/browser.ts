import { chromium, BrowserContext, Frame, Page } from "playwright";
import path from "path";
import { logger } from "./logger";

const EXTENSION_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/.extensions/buster",
);

const USER_DATA_DIR = path.join(process.cwd(), ".browser-data");

let _context: BrowserContext | null = null;
let _launching: Promise<BrowserContext> | null = null;

const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

  const makeMimeType = (type: string, suffixes: string, desc: string) => {
    const mt = { type, suffixes, description: desc } as MimeType;
    Object.defineProperty(mt, "enabledPlugin", { get: () => null });
    return mt;
  };

  const pdfPlugin = {
    0: makeMimeType("application/pdf", "pdf", "Portable Document Format"),
    1: makeMimeType("text/pdf", "pdf", "Portable Document Format"),
    name: "Chrome PDF Plugin",
    description: "Portable Document Format",
    filename: "internal-pdf-viewer",
    length: 2,
    item: (i: number) =>
      i === 0
        ? makeMimeType("application/pdf", "pdf", "Portable Document Format")
        : makeMimeType("text/pdf", "pdf", "Portable Document Format"),
    namedItem: (name: string) =>
      name === "application/pdf"
        ? makeMimeType("application/pdf", "pdf", "Portable Document Format")
        : null,
    [Symbol.iterator]: function* () {
      yield makeMimeType("application/pdf", "pdf", "Portable Document Format");
      yield makeMimeType("text/pdf", "pdf", "Portable Document Format");
    },
  } as unknown as Plugin;

  Object.defineProperty(navigator, "plugins", {
    get: () => {
      const arr = [pdfPlugin] as unknown as PluginArray;
      Object.defineProperty(arr, "item", { value: (i: number) => arr[i] });
      Object.defineProperty(arr, "namedItem", {
        value: (name: string) =>
          name === "Chrome PDF Plugin" ? pdfPlugin : null,
      });
      return arr;
    },
  });

  (window as unknown as Record<string, unknown>)["chrome"] = {
    runtime: {
      connect: () => ({}),
      sendMessage: () => ({}),
      onMessage: { addListener: () => {}, removeListener: () => {} },
      id: undefined,
    },
    loadTimes: () => ({}),
    csi: () => ({}),
    app: {},
  };

  const _Notification = window.Notification;
  if (_Notification) {
    Object.defineProperty(_Notification, "permission", { get: () => "default" });
  }

  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  Object.defineProperty(screen, "colorDepth", { get: () => 24 });
  Object.defineProperty(screen, "pixelDepth", { get: () => 24 });

  const getCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    type: string,
    ...args: unknown[]
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = getCtx.call(this, type, ...(args as any[])) as any;
    if (!ctx) return ctx;
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
      const getParam = ctx.getParameter.bind(ctx);
      ctx.getParameter = (param: number) => {
        if (param === 37445) return "Intel Inc.";
        if (param === 37446) return "Intel Iris OpenGL Engine";
        return getParam(param);
      };
    }
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext;

  if (navigator.permissions) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params: PermissionDescriptor) => {
      if ((params as { name: string }).name === "notifications") {
        return Promise.resolve({
          state: "prompt",
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as PermissionStatus);
      }
      return origQuery(params);
    };
  }

  delete (window as unknown as Record<string, unknown>)["__webdriver_evaluate"];
  delete (window as unknown as Record<string, unknown>)["__selenium_evaluate"];
  delete (window as unknown as Record<string, unknown>)["__webdriver_script_func"];
  delete (window as unknown as Record<string, unknown>)["__webdriver_script_fn"];
  delete (window as unknown as Record<string, unknown>)["__fxdriver_evaluate"];
  delete (window as unknown as Record<string, unknown>)["__driver_unwrapped"];
  delete (window as unknown as Record<string, unknown>)["__webdriver_unwrapped"];
  delete (window as unknown as Record<string, unknown>)["__driver_evaluate"];
  delete (window as unknown as Record<string, unknown>)["__selenium_unwrapped"];
  delete (window as unknown as Record<string, unknown>)["__fxdriver_unwrapped"];
  delete (window as unknown as Record<string, unknown>)["_Selenium_IDE_Recorder"];
  delete (window as unknown as Record<string, unknown>)["_selenium"];
  delete (window as unknown as Record<string, unknown>)["calledSelenium"];
  delete (window as unknown as Record<string, unknown>)["_WEBDRIVER_ELEM_CACHE"];
  delete (window as unknown as Record<string, unknown>)["ChromeDriverw"];
  delete (window as unknown as Record<string, unknown>)["documentMode"];
  delete (window as unknown as Record<string, unknown>)["$chrome_asyncScriptInfo"];
  delete (window as unknown as Record<string, unknown>)["$cdc_asdjflasutopfhvcZLmcfl_"];
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Returns true if a frame URL looks like a reCAPTCHA bframe (the challenge popup). */
function isBframe(url: string): boolean {
  return (
    (url.includes("google.com/recaptcha") || url.includes("recaptcha.net/recaptcha")) &&
    url.includes("bframe")
  );
}

/** Returns true if a frame URL looks like a reCAPTCHA anchor (the checkbox). */
function isAnchorFrame(url: string): boolean {
  return (
    (url.includes("google.com/recaptcha") || url.includes("recaptcha.net/recaptcha")) &&
    url.includes("anchor")
  );
}

/**
 * Collect all frames visible from a given Page or Frame root.
 * Handles nested iframes (e.g. reCAPTCHA inside the Yopmail mail iframe).
 */
function getAllFrames(root: Page | Frame): Frame[] {
  const frames: Frame[] = [];

  const collect = (f: Frame) => {
    frames.push(f);
    for (const child of f.childFrames()) collect(child);
  };

  if ("frames" in root) {
    // Page
    for (const f of (root as Page).frames()) collect(f);
  } else {
    // Frame — collect itself and children
    collect(root as Frame);
  }

  return frames;
}

/**
 * Step 1 of solving a reCAPTCHA: click the "I'm not a robot" checkbox.
 * The anchor frame must already be visible.
 */
async function clickRecaptchaCheckbox(root: Page | Frame): Promise<boolean> {
  const frames = getAllFrames(root);
  for (const f of frames) {
    if (!isAnchorFrame(f.url())) continue;
    try {
      const checkbox = f.locator("#recaptcha-anchor, .recaptcha-checkbox");
      if ((await checkbox.count()) > 0) {
        const checked = await checkbox.getAttribute("aria-checked").catch(() => null);
        if (checked === "true") {
          logger.debug("reCAPTCHA checkbox already checked");
          return true;
        }
        logger.info("Clicking reCAPTCHA checkbox");
        await checkbox.click({ timeout: 5000 });
        return true;
      }
    } catch {
      /* frame may have navigated */
    }
  }
  return false;
}

/**
 * Step 2: wait for the Buster solver button to appear in the bframe,
 * click it, then wait for the CAPTCHA to be dismissed.
 *
 * Buster injects `#solver-button` into the reCAPTCHA challenge bframe.
 * Clicking it triggers the audio-challenge solve flow.
 *
 * Returns true if solved, false if timed out.
 */
async function solveCaptchaWithBuster(
  root: Page | Frame,
  context: string,
): Promise<boolean> {
  const BUSTER_TIMEOUT = 60_000; // 60 s total for Buster to solve
  const POLL_MS = 800;
  const deadline = Date.now() + BUSTER_TIMEOUT;

  logger.info({ context }, "Waiting for Buster to inject solver button into bframe");

  let clicked = false;

  while (Date.now() < deadline) {
    const frames = getAllFrames(root);

    // ── Check if CAPTCHA is already gone (checkbox shows ✓) ────────────────
    const anchorFrames = frames.filter((f) => isAnchorFrame(f.url()));
    for (const af of anchorFrames) {
      try {
        const checked = await af
          .locator("#recaptcha-anchor, .recaptcha-checkbox")
          .getAttribute("aria-checked")
          .catch(() => null);
        if (checked === "true") {
          logger.info({ context }, "reCAPTCHA solved (checkbox checked)");
          return true;
        }
      } catch { /* ignore */ }
    }

    // ── Find the bframe and click the Buster solver button ─────────────────
    if (!clicked) {
      const bframes = frames.filter((f) => isBframe(f.url()));
      for (const bf of bframes) {
        try {
          const btn = bf.locator("#solver-button");
          if ((await btn.count()) > 0) {
            logger.info({ context }, "Found Buster #solver-button — clicking");
            await btn.click({ timeout: 5000, force: true });
            clicked = true;
            logger.info({ context }, "Buster button clicked, waiting for solution...");
            break;
          }
        } catch (e) {
          logger.debug({ context, err: (e as Error).message }, "Could not click Buster button yet");
        }
      }
    }

    await sleep(POLL_MS);
  }

  logger.warn({ context }, "Buster timed out — CAPTCHA not solved");
  return false;
}

/**
 * Full CAPTCHA solving flow for a Page or Frame root:
 *  1. Check if there IS a reCAPTCHA that needs solving.
 *  2. Click the checkbox to trigger the challenge.
 *  3. Use Buster to solve the audio challenge.
 *
 * Returns true if there was no CAPTCHA OR if it was solved successfully.
 * Returns false if CAPTCHA was detected but could not be solved.
 */
export async function solveCaptchaIfPresent(
  root: Page | Frame,
  context: string,
): Promise<boolean> {
  const frames = getAllFrames(root);
  const hasAnchor = frames.some((f) => isAnchorFrame(f.url()));
  const hasBframe = frames.some((f) => isBframe(f.url()));

  if (!hasAnchor && !hasBframe) {
    logger.debug({ context }, "No reCAPTCHA detected");
    return true;
  }

  logger.info({ context }, "reCAPTCHA detected — starting Buster solve flow");

  // Click the checkbox (may immediately pass or open the challenge bframe)
  if (hasAnchor) {
    await clickRecaptchaCheckbox(root);
    // Give the checkbox click a moment to either pass or open the bframe
    await sleep(1500);
  }

  // Re-check: did a simple click already solve it?
  const framesAfterClick = getAllFrames(root);
  for (const af of framesAfterClick.filter((f) => isAnchorFrame(f.url()))) {
    try {
      const checked = await af
        .locator("#recaptcha-anchor, .recaptcha-checkbox")
        .getAttribute("aria-checked")
        .catch(() => null);
      if (checked === "true") {
        logger.info({ context }, "reCAPTCHA passed with checkbox click alone");
        return true;
      }
    } catch { /* ignore */ }
  }

  // Challenge bframe appeared — let Buster handle it
  return solveCaptchaWithBuster(root, context);
}

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

  logger.info({ extensionPath: EXTENSION_PATH }, "Launching browser with Buster extension");

  _launching = chromium
    .launchPersistentContext(USER_DATA_DIR, {
      headless: false,
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
        "--disable-infobars",
        "--window-size=1280,800",
        "--no-first-run",
        "--disable-default-apps",
        // headless=new is required for Chrome extensions to work in headless mode
        "--headless=new",
        `--load-extension=${EXTENSION_PATH}`,
        `--disable-extensions-except=${EXTENSION_PATH}`,
      ],
      ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features=IdleDetection"],
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    })
    .then(async (ctx) => {
      await ctx.addInitScript(STEALTH_SCRIPT);
      _context = ctx;
      logger.info("Browser context with Buster extension ready");
      return ctx;
    });

  return _launching;
}

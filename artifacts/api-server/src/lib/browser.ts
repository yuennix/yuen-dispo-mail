import { chromium, BrowserContext } from "playwright";
import path from "path";
import { logger } from "./logger";

// Path to the unpacked RektCaptcha extension
const EXTENSION_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/.extensions/rektcaptcha",
);

const USER_DATA_DIR = path.join(process.cwd(), ".browser-data");

let _context: BrowserContext | null = null;
let _launching: Promise<BrowserContext> | null = null;

const STEALTH_SCRIPT = () => {
  // Hide webdriver flag
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });

  // Realistic languages
  Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en"],
  });

  // Mock realistic plugins (headless Chrome has 0 — dead giveaway)
  const makeMimeType = (type: string, suffixes: string, desc: string) => {
    const mt = { type, suffixes, description: desc } as MimeType;
    Object.defineProperty(mt, "enabledPlugin", { get: () => null });
    return mt;
  };

  const pdfPlugin = {
    0: makeMimeType("application/pdf", "pdf", "Portable Document Format"),
    1: makeMimeType(
      "text/pdf",
      "pdf",
      "Portable Document Format",
    ),
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

  // Mock window.chrome so fingerprinting scripts see a real browser
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

  // Mock Notification permission to match a real user profile
  const _Notification = window.Notification;
  if (_Notification) {
    Object.defineProperty(_Notification, "permission", {
      get: () => "default",
    });
  }

  // Spoof hardware concurrency (headless often returns 2)
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });

  // Spoof device memory
  Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

  // Realistic platform
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });

  // Realistic screen
  Object.defineProperty(screen, "colorDepth", { get: () => 24 });
  Object.defineProperty(screen, "pixelDepth", { get: () => 24 });

  // WebGL vendor / renderer spoofing
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
        if (param === 37446)
          return "Intel Iris OpenGL Engine";
        return getParam(param);
      };
    }
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext;

  // Permissions API — always return "granted" or "prompt" (never "denied" out of the box)
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

  // Remove common automation artifacts
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
        "--start-maximized",
        "--no-first-run",
        "--disable-default-apps",
        "--headless=new",
        // Load RektCaptcha extension
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
      logger.info("Browser context ready");
      return ctx;
    });

  return _launching;
}

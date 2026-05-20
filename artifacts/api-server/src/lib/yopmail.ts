import axios from "axios";
import * as cheerio from "cheerio";
import { simpleParser } from "mailparser";
import { logger } from "./logger";
import { getBrowserContext, solveCaptchaIfPresent } from "./browser";

const YOPMAIL_BASE = "https://yopmail.com";
const VER = "9.3";

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
};

const IFRAME_HEADERS = {
  ...BASE_HEADERS,
  "Sec-Fetch-Dest": "iframe",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
};

export interface InboxItem {
  id: string;
  from: string;
  subject: string;
  date: string;
  isRead: boolean;
}

export interface InboxResponse {
  email: string;
  messages: InboxItem[];
}

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  html: string;
}

interface Session {
  yp: string;
  yj: string;
  cookies: string;
}

interface YjCache {
  value: string;
  fetchedAt: number;
}

interface SessionCache {
  session: Session;
  cachedAt: number;
}

let yjCache: YjCache | null = null;
const YJ_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Per-address session cache: key = "login@domain"
const sessionCache = new Map<string, SessionCache>();
const SESSION_CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes

function getCachedSession(key: string): Session | null {
  const entry = sessionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(key);
    return null;
  }
  return entry.session;
}

function setCachedSession(key: string, session: Session): void {
  sessionCache.set(key, { session, cachedAt: Date.now() });
}

function invalidateCachedSession(key: string): void {
  sessionCache.delete(key);
}

function mergeCookies(existing: string, setCookieHeaders: string[]): string {
  const map = new Map<string, string>();

  for (const pair of existing.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      map.set(trimmed, "");
    } else {
      map.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
    }
  }

  for (const header of setCookieHeaders) {
    const nameValue = header.split(";")[0].trim();
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    map.set(name, value);
  }

  return Array.from(map.entries())
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join("; ");
}

async function fetchYj(scriptPath?: string): Promise<string> {
  const now = Date.now();
  if (yjCache && now - yjCache.fetchedAt < YJ_CACHE_TTL_MS) {
    logger.debug({ yj: yjCache.value }, "Using cached yj value");
    return yjCache.value;
  }

  const jsUrl = scriptPath
    ? `${YOPMAIL_BASE}${scriptPath}`
    : `${YOPMAIL_BASE}/ver/${VER}/webmail.js`;

  logger.debug({ jsUrl }, "Fetching webmail.js to extract yj");
  const resp = await axios.get(jsUrl, {
    headers: BASE_HEADERS,
    timeout: 10000,
  });

  const match = (resp.data as string).match(/yj=([A-Za-z0-9+/=]+)/);
  if (!match) {
    throw new Error("Unable to extract yj value from Yopmail JS");
  }

  const yj = match[1];
  yjCache = { value: yj, fetchedAt: now };
  logger.debug({ yj }, "Extracted and cached yj value");
  return yj;
}

async function getSession(): Promise<Session> {
  const now = new Date();
  const ytime = `${now.getHours()}:${now.getMinutes()}`;

  const resp = await axios.get(`${YOPMAIL_BASE}/`, {
    headers: {
      ...BASE_HEADERS,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    maxRedirects: 3,
    timeout: 10000,
  });

  const $ = cheerio.load(resp.data);
  const yp =
    $("input#yp").attr("value") || $('input[name="yp"]').attr("value");
  if (!yp) {
    logger.error(
      { html: resp.data.slice(0, 500) },
      "Could not find yp token in Yopmail HTML",
    );
    throw new Error("Unable to obtain Yopmail session token");
  }

  const scriptSrc = $('script[src*="webmail.js"]').attr("src") ?? undefined;
  const yj = await fetchYj(scriptSrc);

  const setCookies: string[] = ([] as string[]).concat(
    resp.headers["set-cookie"] ?? [],
  );
  const baseCookies = setCookies.map((c) => c.split(";")[0]).join("; ");
  const cookies = baseCookies
    ? `${baseCookies}; ytime=${ytime}`
    : `ytime=${ytime}`;

  logger.debug({ yp }, "Yopmail session acquired");
  return { yp, yj, cookies };
}

async function getOrCreateWarmedSession(
  cacheKey: string,
  login: string,
  domain: string,
  isYopmail: boolean,
  baseSession?: Session,
): Promise<Session> {
  const base = baseSession ?? (await getSession());

  const params: Record<string, string | number> = {
    login,
    p: 1,
    d: isYopmail ? "" : domain,
    ctrl: "",
    yp: base.yp,
    yj: base.yj,
    v: VER,
    "r_c": "",
    id: "",
    ad: 0,
  };

  const resp = await axios.get(`${YOPMAIL_BASE}/inbox`, {
    params,
    headers: {
      ...IFRAME_HEADERS,
      Cookie: base.cookies,
      Referer: `${YOPMAIL_BASE}/`,
    },
    timeout: 15000,
  });

  const setCookies: string[] = ([] as string[]).concat(
    resp.headers["set-cookie"] ?? [],
  );
  const warmedCookies = mergeCookies(base.cookies, setCookies);
  const warmed: Session = { ...base, cookies: warmedCookies };

  setCachedSession(cacheKey, warmed);
  logger.debug({ cacheKey }, "Warmed session cached");
  return warmed;
}

export async function fetchInbox(email: string): Promise<InboxResponse> {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) throw new Error("Invalid email address");
  const login = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();
  const isYopmail = domain.includes("yopmail");
  const cacheKey = `${login}@${domain}`;

  let session = getCachedSession(cacheKey);
  if (!session) {
    logger.debug({ login, domain }, "No cached session — warming a new one");
    session = await getOrCreateWarmedSession(cacheKey, login, domain, isYopmail);
  } else {
    logger.debug({ login, domain }, "Reusing cached session for inbox");
  }

  const params: Record<string, string | number> = {
    login,
    p: 1,
    d: isYopmail ? "" : domain,
    ctrl: "",
    yp: session.yp,
    yj: session.yj,
    v: VER,
    "r_c": "",
    id: "",
    ad: 0,
  };

  const resp = await axios.get(`${YOPMAIL_BASE}/inbox`, {
    params,
    headers: {
      ...IFRAME_HEADERS,
      Cookie: session.cookies,
      Referer: `${YOPMAIL_BASE}/`,
    },
    timeout: 15000,
  });

  const freshCookies: string[] = ([] as string[]).concat(
    resp.headers["set-cookie"] ?? [],
  );
  if (freshCookies.length > 0) {
    const merged = mergeCookies(session.cookies, freshCookies);
    const updated: Session = { ...session, cookies: merged };
    setCachedSession(cacheKey, updated);
  }

  const $ = cheerio.load(resp.data);
  const messages: InboxItem[] = [];

  $(".m").each((_i, el) => {
    const $el = $(el);
    const rawId = $el.attr("id") || "";
    const id = rawId.replace(/^e_/, "") || `msg_${_i}`;
    const from =
      $el.find(".lmf").first().text().trim() ||
      $el.find(".lm .lmf").first().text().trim() ||
      "Unknown";
    const subject =
      $el.find(".lms").first().text().trim() ||
      $el.find(".lm .lms").first().text().trim() ||
      "(no subject)";
    const date =
      $el.find(".lmh").first().text().trim() ||
      $el.find(".lmd").first().text().trim() ||
      "";
    const isRead = !$el.hasClass("unread") && !$el.hasClass("new");

    if (id) {
      messages.push({ id, from, subject, date, isRead });
    }
  });

  if (messages.length === 0) {
    const finMatch = resp.data.match(/finrmail\((-?\d+)/);
    const count = finMatch ? parseInt(finMatch[1]) : -1;
    logger.debug(
      { count, html: resp.data.slice(0, 400) },
      "Inbox empty or no messages",
    );
  }

  return { email, messages };
}

/**
 * Parse raw EML data (from /downmail) into an EmailMessage using mailparser.
 * Returns null if the data doesn't look like a valid email.
 */
async function parseEml(raw: Buffer | string, id: string): Promise<EmailMessage | null> {
  try {
    const parsed = await simpleParser(raw);

    const fromAddr = parsed.from?.text ?? "";
    const subject = parsed.subject ?? "(no subject)";
    const date = parsed.date ? parsed.date.toUTCString() : "";

    // Prefer HTML body; fall back to plain text wrapped in <pre>.
    let html = parsed.html || "";
    if (!html && parsed.text) {
      html = `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit">${parsed.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`;
    }

    if (!fromAddr && !subject && !html) return null;

    return { id, from: fromAddr, subject, date, html };
  } catch (err) {
    logger.debug({ err }, "EML parse failed");
    return null;
  }
}

/**
 * PRIMARY fetcher — calls YopMail's native /downmail endpoint.
 *
 * /downmail is the same endpoint the YopMail UI uses for its "Download"
 * button. It returns the raw RFC-822 email (EML) directly, skipping the
 * /mail web renderer that triggers CAPTCHA challenges.
 *
 * ID formats tried (in order): "e_<id>", "<id>", "me_<id>"
 */
async function fetchEmailViaDownload(
  login: string,
  domain: string,
  isYopmail: boolean,
  id: string,
  session: Session,
): Promise<EmailMessage> {
  const referer = isYopmail
    ? `${YOPMAIL_BASE}/en/wm?login=${login}`
    : `${YOPMAIL_BASE}/en/wm?login=${login}&domain=${domain}`;

  const downloadHeaders = {
    ...BASE_HEADERS,
    Accept: "message/rfc822, application/octet-stream, */*",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    Cookie: session.cookies,
    Referer: referer,
  };

  // YopMail's JS passes the raw inbox element ID (e.g. "e_abc123") to /downmail.
  // We strip the "e_" prefix when storing in our InboxItem, so we try both forms.
  const idCandidates = [`e_${id}`, id, `me_${id}`];

  for (const candidate of idCandidates) {
    const params: Record<string, string> = {
      b: login,
      id: candidate,
      yp: session.yp,
      yj: session.yj,
      v: VER,
    };
    if (!isYopmail) params.d = domain;

    logger.debug({ login, id: candidate }, "Downmail: trying id format");

    try {
      const resp = await axios.get(`${YOPMAIL_BASE}/downmail`, {
        params,
        headers: downloadHeaders,
        responseType: "arraybuffer",
        timeout: 15000,
        maxRedirects: 3,
        validateStatus: (s) => s < 500,
      });

      if (resp.status === 400 || resp.status === 404) {
        logger.debug({ id: candidate, status: resp.status }, "Downmail: bad id format, trying next");
        continue;
      }

      const contentType = (resp.headers["content-type"] as string | undefined) ?? "";
      const rawBuffer = Buffer.from(resp.data as ArrayBuffer);

      // If we got an HTML page back (e.g. redirect to homepage or CAPTCHA page)
      // instead of a raw email, skip this candidate.
      if (
        contentType.includes("text/html") ||
        rawBuffer.slice(0, 20).toString().trimStart().startsWith("<!") ||
        rawBuffer.slice(0, 20).toString().trimStart().startsWith("<html")
      ) {
        logger.debug({ id: candidate, contentType }, "Downmail: got HTML instead of EML — skipping");
        continue;
      }

      logger.debug({ id: candidate, contentType, bytes: rawBuffer.length }, "Downmail: got EML response");

      const message = await parseEml(rawBuffer, id);
      if (message) {
        logger.info({ login, id }, "Email fetched via /downmail (no CAPTCHA)");
        return message;
      }

      logger.debug({ id: candidate }, "Downmail: EML parse returned null, trying next");
    } catch (err) {
      logger.debug({ id: candidate, err }, "Downmail: request error, trying next");
    }
  }

  throw new Error(`/downmail failed for all ID formats (login=${login}, id=${id})`);
}

function parseEmailHtml(rawHtml: string, id: string): EmailMessage {
  const $ = cheerio.load(rawHtml);
  const from =
    $(".lmf").first().text().trim() ||
    $('[class*="from"]').first().text().trim() ||
    "";
  const subject =
    $(".lms").first().text().trim() ||
    $("title").text().replace(/yopmail/i, "").trim() ||
    "(no subject)";
  const date = $(".lmh, .lmd, .date").first().text().trim() || "";

  let html = "";
  const mailBody = $(
    "#mail, #mailmillieu, .mail-body, .message-content, #messagectn",
  );
  if (mailBody.length > 0) {
    html = mailBody.html() ?? "";
  } else {
    $("script").remove();
    $("link[rel='stylesheet']").remove();
    $("meta").remove();
    html = $("body").html() ?? rawHtml;
  }

  return { id, from, subject, date, html };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Returns true only if the HTML contains a *visible* reCAPTCHA challenge widget —
 * not just the grecaptcha library script that yopmail always loads.
 */
function htmlHasActiveCaptcha(html: string): boolean {
  return (
    html.includes('class="g-recaptcha"') ||
    html.includes("class='g-recaptcha'") ||
    /data-sitekey=["'][^"']+["']/.test(html) ||
    html.includes("https://www.google.com/recaptcha/api2/anchor") ||
    html.includes("https://www.recaptcha.net/recaptcha/api2/anchor")
  );
}


/**
 * FALLBACK — headless browser that clicks the email row naturally.
 * Only used if /downmail fails.
 */
async function fetchEmailWithBrowser(
  login: string,
  domain: string,
  isYopmail: boolean,
  id: string,
): Promise<EmailMessage> {
  const wmUrl = isYopmail
    ? `${YOPMAIL_BASE}/en/wm?login=${login}`
    : `${YOPMAIL_BASE}/en/wm?login=${login}&domain=${domain}`;

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    logger.debug({ login, domain, id }, "Browser: navigating to webmail");
    await page.goto(wmUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#ifinbox", { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(2000);

    const inboxFrame = page.frameLocator("#ifinbox");
    const emailRow = inboxFrame.locator(`#e_${id}, [id="e_${id}"]`);
    const rowExists = await emailRow.count().then((n) => n > 0).catch(() => false);

    if (rowExists) {
      logger.debug({ login, domain, id }, "Browser: clicking email row in inbox frame");
      await emailRow.click({ timeout: 10000 });

      await page.waitForFunction(
        () => {
          const mailFrame = document.querySelector<HTMLIFrameElement>("#ifmail");
          if (!mailFrame) return false;
          try {
            const body = mailFrame.contentDocument?.body;
            return !!body && body.innerHTML.trim().length > 50;
          } catch {
            return false;
          }
        },
        { timeout: 15000, polling: 500 },
      ).catch(() => null);

      const mailFrameHandle = await page.$("#ifmail");
      if (mailFrameHandle) {
        const mailFrame = await mailFrameHandle.contentFrame();
        if (mailFrame) {
          const solved = await solveCaptchaIfPresent(mailFrame, `mail-frame:${login}@${domain}`);
          if (!solved) {
            throw Object.assign(new Error("CAPTCHA_REQUIRED"), {
              code: "CAPTCHA_REQUIRED",
              yopmailUrl: wmUrl,
            });
          }
          const rawHtml = await mailFrame.content();
          if (htmlHasActiveCaptcha(rawHtml)) {
            throw Object.assign(new Error("CAPTCHA_REQUIRED"), {
              code: "CAPTCHA_REQUIRED",
              yopmailUrl: wmUrl,
            });
          }
          logger.debug({ login, domain, id }, "Browser: email fetched via iframe click");
          return parseEmailHtml(rawHtml, id);
        }
      }
    }

    logger.debug({ login, domain, id }, "Browser: inbox row not found — navigating to /mail");

    const yp = await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("#yp, input[name='yp']");
      return el?.value ?? null;
    });
    const yj = await fetchYj();

    if (!yp) throw new Error("Browser: could not extract yp token");

    const mailParams = new URLSearchParams({
      b: login,
      id: `me_${id}`,
      yp,
      yj,
      v: VER,
      ...(isYopmail ? {} : { d: domain }),
    });

    const mailPageUrl = `${YOPMAIL_BASE}/mail?${mailParams.toString()}`;
    await page.goto(mailPageUrl, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const solved = await solveCaptchaIfPresent(page, `/mail:${login}@${domain}`);
    if (!solved) {
      throw Object.assign(new Error("CAPTCHA_REQUIRED"), {
        code: "CAPTCHA_REQUIRED",
        yopmailUrl: wmUrl,
      });
    }

    const rawHtml = await page.content();

    if (htmlHasActiveCaptcha(rawHtml)) {
      throw Object.assign(new Error("CAPTCHA_REQUIRED"), {
        code: "CAPTCHA_REQUIRED",
        yopmailUrl: wmUrl,
      });
    }

    logger.debug({ login, domain, id }, "Browser: email fetched via /mail");
    return parseEmailHtml(rawHtml, id);
  } finally {
    await page.close();
  }
}

export async function fetchEmail(
  email: string,
  id: string,
): Promise<EmailMessage> {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) throw new Error("Invalid email address");
  const login = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();
  const isYopmail = domain.includes("yopmail");
  const cacheKey = `${login}@${domain}`;

  // Ensure we have a warmed session (needed for /downmail cookies).
  let session = getCachedSession(cacheKey);
  if (!session) {
    logger.debug({ login, domain }, "No cached session — warming for downmail");
    session = await getOrCreateWarmedSession(cacheKey, login, domain, isYopmail);
  }

  // ── STEP 1: Native /downmail — raw EML, no browser, no CAPTCHA ──────────
  try {
    return await fetchEmailViaDownload(login, domain, isYopmail, id, session);
  } catch (dlErr) {
    logger.warn(
      { err: (dlErr as Error).message },
      "Downmail failed — falling back to browser",
    );
  }

  // ── STEP 2: Headless browser — natural UI interaction ────────────────────
  try {
    return await fetchEmailWithBrowser(login, domain, isYopmail, id);
  } catch (browserErr) {
    const be = browserErr as Error & { code?: string };
    if (be.code === "CAPTCHA_REQUIRED") throw browserErr;
    logger.warn(
      { err: be.message },
      "Browser fetch failed — falling back to axios /mail",
    );
  }

  // ── STEP 3: Axios /mail — last resort ────────────────────────────────────
  logger.debug({ login, domain, id }, "Axios /mail fallback");

  const mailParams: Record<string, string> = {
    b: login,
    id: `me_${id}`,
    yp: session.yp,
    yj: session.yj,
    v: VER,
  };
  if (!isYopmail) mailParams.d = domain;

  const mailHeaders = {
    ...IFRAME_HEADERS,
    Cookie: session.cookies,
    Referer: `${YOPMAIL_BASE}/`,
  };

  const resp = await axios.get(`${YOPMAIL_BASE}/mail`, {
    params: mailParams,
    headers: mailHeaders,
    timeout: 15000,
  });

  let rawHtml = resp.data as string;

  // ── CAPTCHA detected in axios response ───────────────────────────────────
  // The browser path (Step 2) already handles CAPTCHAs via the Buster extension.
  // If we reach here and still see a CAPTCHA, there's nothing more to do.
  if (
    rawHtml.includes("g-recaptcha") ||
    rawHtml.includes("grecaptcha") ||
    rawHtml.includes("recaptcha")
  ) {
    logger.warn({ login, id }, "Axios /mail: CAPTCHA detected in last-resort fallback");
    invalidateCachedSession(cacheKey);
    const yopmailUrl = `${YOPMAIL_BASE}/en/wm?login=${login}${!isYopmail ? `&domain=${domain}` : ""}`;
    throw Object.assign(new Error("CAPTCHA_REQUIRED"), {
      code: "CAPTCHA_REQUIRED",
      yopmailUrl,
    });
  }

  return parseEmailHtml(rawHtml, id);
}

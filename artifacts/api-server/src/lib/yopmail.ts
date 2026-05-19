import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";
import { getBrowserContext } from "./browser";

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

/**
 * Merge Set-Cookie headers from a response into an existing cookie string.
 * New values for the same cookie name override old ones.
 */
function mergeCookies(existing: string, setCookieHeaders: string[]): string {
  const map = new Map<string, string>();

  // Parse existing cookies into the map
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

  // Override/add from Set-Cookie headers (take only the name=value part before the first ";")
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

/**
 * Get a base session (yp, yj, cookies) from the Yopmail homepage.
 */
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

/**
 * Build or reuse a warmed session for a given inbox.
 * Visits the /inbox endpoint so Yopmail sets the cookies required by /mail.
 * Persists the result in the session cache so subsequent calls reuse it.
 */
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

  // Reuse an existing warmed session if available; otherwise create one.
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

  // Absorb any fresh cookies yopmail sends back and update the cache.
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

/**
 * Fetch an email using a real headless browser.
 * The persistent browser context accumulates cookies and executes JavaScript
 * challenges, making it appear as a genuine returning user to Yopmail.
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

    // Visit the webmail page — this executes JS, sets cookies, builds trust.
    await page.goto(wmUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Extract the yp token the page injected into the DOM.
    const yp = await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>(
        "#yp, input[name='yp']",
      );
      return el?.value ?? null;
    });

    // Get yj from the already-cached value (avoids a second JS download).
    const yj = await fetchYj();

    if (!yp) {
      throw new Error("Browser: could not extract yp token from webmail page");
    }

    // Now navigate the browser directly to the /mail endpoint.
    // The browser carries all cookies and the proper fingerprint so
    // Yopmail treats this as a continuation of the same session.
    const mailParams = new URLSearchParams({
      b: login,
      id: `me_${id}`,
      yp,
      yj,
      v: VER,
      ...(isYopmail ? {} : { d: domain }),
    });

    logger.debug({ login, domain, id }, "Browser: fetching mail endpoint");
    await page.goto(`${YOPMAIL_BASE}/mail?${mailParams.toString()}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const rawHtml = await page.content();

    if (
      rawHtml.includes("g-recaptcha") ||
      rawHtml.includes("grecaptcha") ||
      rawHtml.includes("recaptcha")
    ) {
      const yopmailUrl = wmUrl;
      const err = new Error("CAPTCHA_REQUIRED") as Error & {
        code: string;
        yopmailUrl: string;
      };
      err.code = "CAPTCHA_REQUIRED";
      err.yopmailUrl = yopmailUrl;
      throw err;
    }

    logger.debug({ login, domain, id }, "Browser: email fetched successfully");
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

  // Try the headless browser first — it executes JavaScript challenges and
  // carries a persistent cookie jar, greatly reducing CAPTCHA triggers.
  try {
    return await fetchEmailWithBrowser(login, domain, isYopmail, id);
  } catch (browserErr) {
    const be = browserErr as Error & { code?: string; yopmailUrl?: string };

    // If the browser itself detected CAPTCHA, propagate it — no point retrying with axios.
    if (be.code === "CAPTCHA_REQUIRED") throw browserErr;

    logger.warn(
      { err: be.message },
      "Browser fetch failed — falling back to axios",
    );
  }

  // Axios fallback: reuse the warmed session if available.
  let session = getCachedSession(cacheKey);
  if (!session) {
    logger.debug({ login, domain }, "No cached session for email fetch — warming");
    session = await getOrCreateWarmedSession(cacheKey, login, domain, isYopmail);
  }

  logger.debug({ login, domain, id }, "Axios fallback: fetching email");

  const mailId = `me_${id}`;
  const params: Record<string, string> = {
    b: login,
    id: mailId,
    yp: session.yp,
    yj: session.yj,
    v: VER,
  };

  if (!isYopmail) {
    params.d = domain;
  }

  const resp = await axios.get(`${YOPMAIL_BASE}/mail`, {
    params,
    headers: {
      ...IFRAME_HEADERS,
      Cookie: session.cookies,
      Referer: `${YOPMAIL_BASE}/`,
    },
    timeout: 15000,
  });

  const rawHtml = resp.data as string;

  if (
    rawHtml.includes("g-recaptcha") ||
    rawHtml.includes("grecaptcha") ||
    rawHtml.includes("recaptcha")
  ) {
    invalidateCachedSession(cacheKey);
    const yopmailUrl = `https://yopmail.com/en/wm?login=${login}${!isYopmail ? `&domain=${domain}` : ""}`;
    const err = new Error("CAPTCHA_REQUIRED") as Error & {
      code: string;
      yopmailUrl: string;
    };
    err.code = "CAPTCHA_REQUIRED";
    err.yopmailUrl = yopmailUrl;
    throw err;
  }

  return parseEmailHtml(rawHtml, id);
}

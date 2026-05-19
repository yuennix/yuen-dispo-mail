import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";

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

let yjCache: YjCache | null = null;
const YJ_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
 * Get a session that has visited the inbox, which causes Yopmail to set the
 * `yc` cookie needed for subsequent `/mail` requests to succeed.
 */
async function getInboxWarmedSession(
  login: string,
  domain: string,
  isYopmail: boolean,
): Promise<Session> {
  const session = await getSession();

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

  const setCookies: string[] = ([] as string[]).concat(
    resp.headers["set-cookie"] ?? [],
  );
  const warmedCookies = mergeCookies(session.cookies, setCookies);

  logger.debug("Inbox visited for cookie warm-up");
  return { ...session, cookies: warmedCookies };
}

export async function fetchInbox(email: string): Promise<InboxResponse> {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) throw new Error("Invalid email address");
  const login = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();
  const isYopmail = domain.includes("yopmail");

  const session = await getSession();
  logger.debug({ login, domain }, "Fetching inbox");

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

export async function fetchEmail(
  email: string,
  id: string,
): Promise<EmailMessage> {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) throw new Error("Invalid email address");
  const login = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();
  const isYopmail = domain.includes("yopmail");

  // Visit inbox first so Yopmail sets the `compte` and `ywm` cookies required by /mail
  const session = await getInboxWarmedSession(login, domain, isYopmail);
  logger.debug({ login, domain, id }, "Fetching email");

  // Yopmail's /mail endpoint expects id = "m" + elementId, where elementId is the
  // inbox DOM attribute value "e_<base64>". Since fetchInbox stores ids with the
  // "e_" prefix stripped, we reconstruct the full id as "me_<id>".
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

  const $ = cheerio.load(resp.data);

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
    html = $("body").html() ?? resp.data;
  }

  return { id, from, subject, date, html };
}

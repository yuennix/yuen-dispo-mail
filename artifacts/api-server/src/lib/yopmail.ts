import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "./logger";

const YOPMAIL_BASE = "https://yopmail.com";
const YJ = "PAwHmZGtkBGtjAQVlAQpmAwx";
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
  cookies: string;
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

  const setCookies: string[] = ([] as string[]).concat(
    resp.headers["set-cookie"] ?? [],
  );
  const baseCookies = setCookies.map((c) => c.split(";")[0]).join("; ");
  const cookies = baseCookies
    ? `${baseCookies}; ytime=${ytime}`
    : `ytime=${ytime}`;

  logger.debug({ yp }, "Yopmail session acquired");
  return { yp, cookies };
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
    yj: YJ,
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
    const id = $el.attr("id") || `msg_${_i}`;
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

  const session = await getSession();
  logger.debug({ login, domain, id }, "Fetching email");

  const mailId = `m${id}`;

  const params: Record<string, string> = {
    b: login,
    id: mailId,
    yp: session.yp,
    yj: YJ,
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

import axios from "axios";
import { logger } from "./logger";

const FASTCAPTCHA_BASE = "https://fastcaptcha.org";
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 3000;

function getApiKey(): string {
  const key = process.env["FASTCAPTCHA_API_KEY"];
  if (!key) throw new Error("FASTCAPTCHA_API_KEY environment variable is not set");
  return key;
}

interface CreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
}

interface TaskResultResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status: "processing" | "ready";
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
}

/**
 * Solve a reCAPTCHA v2 challenge using FastCaptcha.org.
 * Returns the g-recaptcha-response token.
 */
export async function solveRecaptchaV2(
  websiteURL: string,
  websiteKey: string,
): Promise<string> {
  const clientKey = getApiKey();

  logger.info({ websiteURL, websiteKey }, "Submitting reCAPTCHA task to FastCaptcha");

  const createResp = await axios.post<CreateTaskResponse>(
    `${FASTCAPTCHA_BASE}/createTask`,
    {
      clientKey,
      task: {
        type: "RecaptchaV2TaskProxyless",
        websiteURL,
        websiteKey,
      },
    },
    { timeout: 15000 },
  );

  const createData = createResp.data;

  if (createData.errorId !== 0) {
    throw new Error(
      `FastCaptcha createTask error: ${createData.errorCode ?? "unknown"} — ${createData.errorDescription ?? ""}`,
    );
  }

  const taskId = createData.taskId;
  if (!taskId) {
    throw new Error("FastCaptcha returned no taskId");
  }

  logger.info({ taskId }, "reCAPTCHA task created, polling for result");

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const resultResp = await axios.post<TaskResultResponse>(
      `${FASTCAPTCHA_BASE}/getTaskResult`,
      { clientKey, taskId },
      { timeout: 15000 },
    );

    const resultData = resultResp.data;

    if (resultData.errorId !== 0) {
      throw new Error(
        `FastCaptcha getTaskResult error: ${resultData.errorCode ?? "unknown"} — ${resultData.errorDescription ?? ""}`,
      );
    }

    if (resultData.status === "ready") {
      const token =
        resultData.solution?.gRecaptchaResponse ??
        resultData.solution?.token;

      if (!token) {
        throw new Error("FastCaptcha returned ready status but no token in solution");
      }

      logger.info({ taskId, attempt }, "reCAPTCHA solved by FastCaptcha");
      return token;
    }

    logger.debug({ taskId, attempt }, "reCAPTCHA still processing...");
  }

  throw new Error(`FastCaptcha: timed out waiting for solution after ${MAX_POLL_ATTEMPTS} attempts`);
}

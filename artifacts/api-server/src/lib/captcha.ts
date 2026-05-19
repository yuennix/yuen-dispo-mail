import axios from "axios";
import { logger } from "./logger";

const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 3000;

function getApiKey(): string {
  const key = process.env["FASTCAPTCHA_API_KEY"];
  if (!key) throw new Error("FASTCAPTCHA_API_KEY environment variable is not set");
  return key;
}

/**
 * Solve a reCAPTCHA v2 using FastCaptcha (2captcha-compatible API format).
 * Returns the g-recaptcha-response token.
 */
export async function solveRecaptchaV2(
  websiteURL: string,
  websiteKey: string,
): Promise<string> {
  const apiKey = getApiKey();

  logger.info({ websiteURL, websiteKey }, "Submitting reCAPTCHA to FastCaptcha (2captcha format)");

  // Step 1: submit the task
  const submitParams = new URLSearchParams({
    key: apiKey,
    method: "userrecaptcha",
    googlekey: websiteKey,
    pageurl: websiteURL,
    json: "1",
  });

  const submitResp = await axios.post<{ status: number; request: string }>(
    "https://fastcaptcha.org/in.php",
    submitParams.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    },
  );

  const submitData = submitResp.data;

  if (submitData.status !== 1) {
    throw new Error(`FastCaptcha submit error: ${submitData.request}`);
  }

  const taskId = submitData.request;
  logger.info({ taskId }, "FastCaptcha task submitted, polling for result");

  // Step 2: poll for the result
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const resultResp = await axios.get<{ status: number; request: string }>(
      "https://fastcaptcha.org/res.php",
      {
        params: {
          key: apiKey,
          action: "get",
          id: taskId,
          json: "1",
        },
        timeout: 15000,
      },
    );

    const resultData = resultResp.data;

    if (resultData.request === "CAPCHA_NOT_READY") {
      logger.debug({ taskId, attempt }, "FastCaptcha: still solving...");
      continue;
    }

    if (resultData.status !== 1) {
      throw new Error(`FastCaptcha result error: ${resultData.request}`);
    }

    const token = resultData.request;
    logger.info({ taskId, attempt }, "FastCaptcha: reCAPTCHA solved");
    return token;
  }

  throw new Error(`FastCaptcha: timed out after ${MAX_POLL_ATTEMPTS} attempts`);
}

import { Router, type IRouter } from "express";
import { fetchInbox, fetchEmail } from "../lib/yopmail";
import {
  GetInboxQueryParams,
  GetInboxResponse,
  GetEmailQueryParams,
  GetEmailResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/inbox", async (req, res): Promise<void> => {
  const parsed = GetInboxQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email } = parsed.data;

  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  try {
    const inbox = await fetchInbox(email);
    res.json(GetInboxResponse.parse(inbox));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch inbox");
    res.status(502).json({ error: "Failed to fetch inbox from mail server" });
  }
});

router.get("/email", async (req, res): Promise<void> => {
  const parsed = GetEmailQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, id } = parsed.data;

  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  if (!id) {
    res.status(400).json({ error: "Missing message ID" });
    return;
  }

  try {
    const message = await fetchEmail(email, id);
    res.json(GetEmailResponse.parse(message));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch email");
    res.status(502).json({ error: "Failed to fetch email from mail server" });
  }
});

export default router;

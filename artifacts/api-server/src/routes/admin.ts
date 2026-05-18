import { Router, type IRouter } from "express";
import { db, domainsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  AddDomainBody,
  DeleteDomainParams,
  ListDomainsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/admin/domains", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(domainsTable)
    .orderBy(domainsTable.createdAt);

  res.json(
    ListDomainsResponse.parse({
      domains: rows.map((r) => ({
        id: r.id,
        domain: r.domain,
        label: r.label ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    }),
  );
});

router.post("/admin/domains", async (req, res): Promise<void> => {
  const parsed = AddDomainBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { domain, label } = parsed.data;

  const normalized = domain.toLowerCase().trim();
  if (!normalized || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) {
    res.status(400).json({ error: "Invalid domain format" });
    return;
  }

  try {
    const [row] = await db
      .insert(domainsTable)
      .values({ domain: normalized, label: label ?? null })
      .returning();

    res.status(201).json({
      id: row.id,
      domain: row.domain,
      label: row.label ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique")) {
      res.status(400).json({ error: "Domain already exists" });
    } else {
      req.log.error({ err }, "Failed to add domain");
      res.status(500).json({ error: "Failed to add domain" });
    }
  }
});

router.delete("/admin/domains/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteDomainParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [deleted] = await db
    .delete(domainsTable)
    .where(eq(domainsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;

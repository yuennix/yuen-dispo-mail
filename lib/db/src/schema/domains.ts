import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const domainsTable = pgTable("domains", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull().unique(),
  label: text("label"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Domain = typeof domainsTable.$inferSelect;
export type InsertDomain = typeof domainsTable.$inferInsert;

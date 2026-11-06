import { Hono } from "hono";
import { reports } from "@da/db";
import { AppError, flagCreate, flagDelete } from "@da/shared";
import { type AppEnv, audit, staff } from "../lib/context";
import { metric } from "../lib/services";
import { body, rateLimit, requirePerm } from "../middleware";
import { loadClient } from "./clients";

/** Mounted under /clients/:id/reports */
export const clientReportRoutes = new Hono<AppEnv>()
  .get("/", requirePerm("report:read"), async (c) => {
    const row = await loadClient(c, c.req.param("id") ?? "");
    return c.json(await reports.listReports(c.get("db"), row.orgId, row.id));
  })
  // R12.1, R12.9: start a workflow and return immediately; one import per client at a time.
  .post("/import", requirePerm("report:import"), async (c) => {
    const row = await loadClient(c, c.req.param("id") ?? "");
    await rateLimit(c.env.IMPORT_LIMIT, `client:${row.id}`);
    const db = c.get("db");
    const active = await reports.activeImport(db, row.orgId, row.id);
    if (active) throw new AppError("import_in_progress", 409, "An import is already in progress for this client", { reportId: active.id });
    const rep = await reports.createReport(db, row.orgId, row.id, c.env.CREDIT_PROVIDER, staff(c).id);
    const inst = await c.env.WF_IMPORT.create({ id: rep.id, params: { orgId: row.orgId, clientId: row.id, reportId: rep.id } });
    await reports.updateReport(db, rep.id, { workflowId: inst.id });
    audit(c, { action: "report.import_requested", entityType: "report", entityId: rep.id, diff: { clientId: row.id } });
    metric(c.env, "import_requested", row.orgId);
    return c.json({ reportId: rep.id, workflowId: inst.id, status: rep.status }, 202);
  });

export const reportRoutes = new Hono<AppEnv>()
  .get("/:id", requirePerm("report:read"), async (c) => {
    const r = await reports.getReport(c.get("db"), staff(c).orgId, c.req.param("id"));
    if (!r) throw new AppError("not_found", 404, "Report not found");
    const list = await reports.listReports(c.get("db"), r.orgId, r.clientId);
    return c.json(list.find((x) => x.id === r.id));
  })
  .get("/:id/items", requirePerm("report:read"), async (c) => {
    const db = c.get("db");
    const p = staff(c);
    const r = await reports.getReport(db, p.orgId, c.req.param("id"));
    if (!r) throw new AppError("not_found", 404, "Report not found");
    return c.json(await reports.itemDtos(db, p.orgId, await reports.itemsForReport(db, p.orgId, r.id)));
  });

export const itemRoutes = new Hono<AppEnv>()
  /** Same account across imports (R13.4). */
  .get("/:id/history", requirePerm("report:read"), async (c) => {
    const db = c.get("db");
    const p = staff(c);
    const item = await reports.getItem(db, p.orgId, c.req.param("id"));
    if (!item) throw new AppError("not_found", 404, "Item not found");
    return c.json(await reports.itemDtos(db, p.orgId, await reports.itemHistory(db, p.orgId, item.clientId, item.fingerprint)));
  })
  // R13.3: manual flags with a reason, audited.
  .post("/:id/flags", requirePerm("flag:write"), async (c) => {
    const { reason } = await body(c, flagCreate);
    const p = staff(c);
    const item = await reports.getItem(c.get("db"), p.orgId, c.req.param("id"));
    if (!item) throw new AppError("not_found", 404, "Item not found");
    const [f] = await reports.insertFlags(c.get("db"), p.orgId, [{ itemId: item.id, ruleId: null, reason, source: "manual", createdBy: p.id }]);
    audit(c, { action: "flag.added", entityType: "report_item", entityId: item.id, diff: { flagId: f.id, reason } });
    return c.json({ id: f.id, reason, source: "manual", ruleId: null, createdAt: f.createdAt }, 201);
  })
  .delete("/:id/flags/:flagId", requirePerm("flag:write"), async (c) => {
    const { reason } = await body(c, flagDelete);
    const p = staff(c);
    const f = await reports.getFlag(c.get("db"), p.orgId, c.req.param("flagId"));
    if (!f || f.reportItemId !== c.req.param("id")) throw new AppError("not_found", 404, "Flag not found");
    await reports.deleteFlag(c.get("db"), p.orgId, f.id);
    audit(c, { action: "flag.removed", entityType: "report_item", entityId: f.reportItemId, diff: { flagId: f.id, flagReason: f.reason, source: f.source, removalReason: reason } });
    return c.json({ ok: true });
  });

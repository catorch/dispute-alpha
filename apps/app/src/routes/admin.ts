import { Hono } from "hono";
import { z } from "zod";
import { auditRepo, clients, letters, ops, orgs, reports, tasks } from "@da/db";
import {
  AppError,
  type Me,
  auditExportRequest,
  auditQuery,
  flagRuleInput,
  orgSettingsUpdate,
  parseDay,
  taskCreate,
  taskListQuery,
  taskUpdate,
  templateCreate,
  templateVersion,
  userCreate,
  userUpdate,
  validateTemplate,
  DAY,
} from "@da/shared";
import { type AppEnv, type Ctx, audit, staff } from "../lib/context";
import { sanitizeHtml } from "../lib/sanitize";
import { link, notify } from "../lib/services";
import { body, parse, query, requirePerm } from "../middleware";

async function cleanTemplate(html: string) {
  const clean = await sanitizeHtml(html);
  const unknown = validateTemplate(clean);
  if (unknown.length) throw new AppError("template_invalid", 422, `Unknown merge fields: ${unknown.map((f) => `{{${f}}}`).join(", ")}`, { unknown });
  return clean;
}

async function assertActiveStaff(c: Ctx, id: string) {
  const u = await orgs.getUser(c.get("db"), staff(c).orgId, id);
  if (!u || u.status !== "active") throw new AppError("invalid_assignee", 400, "Choose an active staff member");
  return u;
}

export const adminRoutes = new Hono<AppEnv>()
  .get("/me", (c) => {
    const p = staff(c);
    const me: Me = { kind: "staff", id: p.id, orgId: p.orgId, email: p.email, displayName: p.displayName, role: p.role, permissions: [...p.permissions] };
    return c.json(me);
  })

  // ---------- staff users (R8) ----------
  .get("/users", async (c) => c.json(await orgs.listUsers(c.get("db"), staff(c).orgId)))
  .post("/users", requirePerm("user:write"), async (c) => {
    const input = await body(c, userCreate);
    if (await orgs.findActiveUserByEmail(c.get("db"), input.email)) throw new AppError("user_exists", 409, "A user with this email already exists");
    const u = await orgs.createUser(c.get("db"), staff(c).orgId, input);
    audit(c, { action: "user.created", entityType: "user", entityId: u.id, diff: input });
    return c.json(u, 201);
  })
  .patch("/users/:id", requirePerm("user:write"), async (c) => {
    const input = await body(c, userUpdate);
    const p = staff(c);
    const db = c.get("db");
    if (c.req.param("id") === p.id && (input.status === "inactive" || (input.role && input.role !== "org_admin"))) throw new AppError("self_change", 409, "You cannot deactivate or demote yourself");
    const r = await orgs.updateUser(db, p.orgId, c.req.param("id"), input);
    if (!r) throw new AppError("not_found", 404, "User not found");
    audit(c, { action: "user.updated", entityType: "user", entityId: r.after.id, diff: r });
    // R8.2: deactivation flags assigned clients for reassignment.
    if (input.status === "inactive" && r.before.status === "active") {
      const assigned = await clients.clientsAssignedTo(db, p.orgId, r.after.id);
      if (assigned.length) {
        for (const a of await orgs.orgAdmins(db, p.orgId)) {
          await tasks.createTask(db, p.orgId, {
            title: `Reassign ${assigned.length} client(s) from ${r.after.displayName}`,
            assigneeId: a.id,
            entityType: "user",
            entityId: r.after.id,
            createdByKind: "system",
            dedupeKey: `reassign:${r.after.id}:${a.id}:${Date.now()}`,
          });
        }
      }
    }
    return c.json(r.after);
  })

  // ---------- organization settings (R8.3) ----------
  .get("/org/settings", async (c) => {
    const o = await orgs.getOrg(c.get("db"), staff(c).orgId);
    if (!o) throw new AppError("not_found", 404, "Organization not found");
    return c.json({ ...o.settings, orgName: o.name });
  })
  .patch("/org/settings", requirePerm("org:write"), async (c) => {
    const input = await body(c, orgSettingsUpdate);
    const r = await orgs.updateOrgSettings(c.get("db"), staff(c).orgId, input);
    if (!r) throw new AppError("not_found", 404, "Organization not found");
    audit(c, { action: "org.settings_updated", entityType: "organization", entityId: staff(c).orgId, diff: r });
    return c.json(r.after);
  })

  // ---------- letter templates (R14.2) ----------
  .get("/templates", requirePerm("letter:read"), async (c) => c.json(await letters.listTemplates(c.get("db"), staff(c).orgId, { includeHistory: c.req.query("history") === "1" })))
  .get("/templates/:id", requirePerm("letter:read"), async (c) => {
    const t = await letters.getTemplate(c.get("db"), staff(c).orgId, c.req.param("id"));
    if (!t) throw new AppError("not_found", 404, "Template not found");
    return c.json(t);
  })
  .post("/templates", requirePerm("template:write"), async (c) => {
    const input = await body(c, templateCreate);
    const p = staff(c);
    const existing = await letters.listTemplates(c.get("db"), p.orgId);
    if (existing.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) throw new AppError("template_exists", 409, "A template with this name exists. Save a new version instead.");
    const t = await letters.createTemplateVersion(c.get("db"), p.orgId, input.name, await cleanTemplate(input.bodyHtml), p.id);
    audit(c, { action: "template.created", entityType: "letter_template", entityId: t.id, diff: { name: t.name } });
    return c.json(t, 201);
  })
  .post("/templates/:id/versions", requirePerm("template:write"), async (c) => {
    const input = await body(c, templateVersion);
    const p = staff(c);
    const base = await letters.getTemplate(c.get("db"), p.orgId, c.req.param("id"));
    if (!base) throw new AppError("not_found", 404, "Template not found");
    const t = await letters.createTemplateVersion(c.get("db"), p.orgId, base.name, await cleanTemplate(input.bodyHtml), p.id);
    audit(c, { action: "template.versioned", entityType: "letter_template", entityId: t.id, diff: { name: t.name, from: base.version, to: t.version } });
    return c.json(t, 201);
  })
  .patch("/templates/:id", requirePerm("template:write"), async (c) => {
    const { active } = await body(c, z.object({ active: z.boolean() }));
    const t = await letters.getTemplate(c.get("db"), staff(c).orgId, c.req.param("id"));
    if (!t) throw new AppError("not_found", 404, "Template not found");
    await letters.setTemplateActive(c.get("db"), staff(c).orgId, t.id, active);
    audit(c, { action: active ? "template.activated" : "template.deactivated", entityType: "letter_template", entityId: t.id });
    return c.json({ ...t, active });
  })

  // ---------- flag rules (R13.6) ----------
  .get("/flag-rules", requirePerm("report:read"), async (c) => c.json(await reports.listRules(c.get("db"), staff(c).orgId)))
  .post("/flag-rules", requirePerm("rule:write"), async (c) => {
    const input = await body(c, flagRuleInput);
    if (input.kind === "condition" && !input.condition) throw new AppError("validation_failed", 400, "A condition rule needs a condition");
    const r = await reports.createRule(c.get("db"), staff(c).orgId, input);
    audit(c, { action: "flag_rule.created", entityType: "flag_rule", entityId: r.id, diff: input });
    return c.json(r, 201);
  })
  .patch("/flag-rules/:id", requirePerm("rule:write"), async (c) => {
    const input = await body(c, flagRuleInput.partial());
    const r = await reports.updateRule(c.get("db"), staff(c).orgId, c.req.param("id"), input);
    if (!r) throw new AppError("not_found", 404, "Rule not found");
    audit(c, { action: "flag_rule.updated", entityType: "flag_rule", entityId: r.after.id, diff: r });
    return c.json(r.after);
  })

  // ---------- tasks (R17.1) ----------
  .get("/tasks", requirePerm("task:read"), async (c) => {
    const q = query(c, taskListQuery);
    const p = staff(c);
    return c.json(await tasks.listTasks(c.get("db"), p.orgId, { status: q.status, assigneeId: q.assignee === "me" ? p.id : q.assignee }));
  })
  .post("/tasks", requirePerm("task:write"), async (c) => {
    const input = await body(c, taskCreate);
    const p = staff(c);
    await assertActiveStaff(c, input.assigneeId);
    const t = await tasks.createTask(c.get("db"), p.orgId, { ...input, dueAt: input.dueAt ? parseDay(input.dueAt) : null, createdByKind: "staff", createdById: p.id });
    if (!t) throw new AppError("conflict", 409, "Task already exists");
    audit(c, { action: "task.created", entityType: "task", entityId: t.id, diff: input });
    if (input.assigneeId !== p.id)
      await notify(c.env, { id: `task:${t.id}`, orgId: p.orgId, recipient: { kind: "staff", id: input.assigneeId }, event: "task_assigned", vars: { link: link(c.env, "/admin/tasks") } });
    return c.json(t, 201);
  })
  .patch("/tasks/:id", requirePerm("task:write"), async (c) => {
    const input = await body(c, taskUpdate);
    const p = staff(c);
    const t = await tasks.getTask(c.get("db"), p.orgId, c.req.param("id"));
    if (!t) throw new AppError("not_found", 404, "Task not found");
    if (input.assigneeId) await assertActiveStaff(c, input.assigneeId);
    const patch = { ...input, dueAt: input.dueAt === undefined ? undefined : input.dueAt ? parseDay(input.dueAt) : null };
    await tasks.updateTask(c.get("db"), p.orgId, t.id, patch);
    audit(c, { action: "task.updated", entityType: "task", entityId: t.id, diff: { before: { status: t.status, assigneeId: t.assigneeId, title: t.title }, after: input } });
    return c.json({ ok: true });
  })

  // ---------- in-app notifications (R18.7) ----------
  .get("/notifications", async (c) => {
    const p = staff(c);
    return c.json(await tasks.listNotifications(c.get("db"), p.orgId, "staff", p.id));
  })
  .post("/notifications/read", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.union([z.array(z.string().max(64)).max(200), z.literal("all")]) }));
    const p = staff(c);
    await tasks.markNotificationRead(c.get("db"), p.orgId, "staff", p.id, ids);
    return c.json({ ok: true });
  })

  // ---------- audit (R19.4, R19.6) ----------
  .get("/audit", requirePerm("audit:read"), async (c) => {
    const q = query(c, auditQuery);
    return c.json(await auditRepo.query(c.get("db"), staff(c).orgId, { ...q, from: q.from ? parseDay(q.from) : undefined, to: q.to ? parseDay(q.to) + DAY : undefined }));
  })
  .post("/audit/export", requirePerm("audit:export"), async (c) => {
    const input = await body(c, auditExportRequest);
    if (parseDay(input.to) < parseDay(input.from)) throw new AppError("validation_failed", 400, "The end date must be after the start date");
    const p = staff(c);
    const exp = await ops.createAuditExport(c.get("db"), p.orgId, p.id, input);
    await c.env.Q_AUDIT_EXPORT.send({ exportId: exp.id });
    audit(c, { action: "audit.export_requested", entityType: "audit_export", entityId: exp.id, diff: input });
    return c.json({ exportId: exp.id, status: exp.status }, 202);
  })
  .get("/audit/export/:id", requirePerm("audit:export"), async (c) => {
    const e = await ops.getAuditExport(c.get("db"), c.req.param("id"));
    if (!e || e.orgId !== staff(c).orgId) throw new AppError("not_found", 404, "Export not found");
    return c.json({ exportId: e.id, status: e.status, documentId: e.documentId, params: parse(auditExportRequest, JSON.parse(e.paramsJson)) });
  });

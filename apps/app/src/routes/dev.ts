import { Hono } from "hono";
import { auth as authRepo, clients, orgs, reports } from "@da/db";
import { AppError } from "@da/shared";
import { isDevLike } from "../env";
import type { AppEnv } from "../lib/context";
import { hashPassword } from "../lib/password";

export const DEMO_CLIENT = { email: "client@local.test", password: "demo password 123" };

/**
 * Local/test only (404 in every deployed environment). Idempotent: seeds an organization with an
 * admin (DEV_STAFF_EMAIL), a staff user, an approver, and a demo client who can sign in to the
 * portal straight away (email-code MFA; the code is printed in the `pnpm dev` console).
 */
export const devRoutes = new Hono<AppEnv>().post("/seed", async (c) => {
  if (!isDevLike(c.env)) throw new AppError("not_found", 404, "Not found");
  const db = c.get("db");
  const adminEmail = (c.env.DEV_STAFF_EMAIL ?? "admin@local.test").toLowerCase();
  let orgId = (await orgs.findActiveUserByEmail(db, adminEmail))?.orgId;
  const created = !orgId;
  if (!orgId) {
    ({ orgId } = await orgs.createOrg(db, "Local Dev Credit Co", { email: adminEmail, displayName: "Dev Admin" }));
    await orgs.createUser(db, orgId, { email: "staff@local.test", displayName: "Dev Staff", role: "staff" });
    await orgs.createUser(db, orgId, { email: "approver@local.test", displayName: "Dev Approver", role: "approver" });
    await orgs.updateOrgSettings(db, orgId, { senderBlock: { name: "Local Dev Credit Co", addressLines: ["100 Congress Ave", "Austin, TX 78701"] } });
  }

  if (!(await authRepo.findAccountByEmail(db, DEMO_CLIENT.email))) {
    const staff = await orgs.findActiveUserByEmail(db, "staff@local.test");
    const clientId = await clients.createClient(db, c.get("fc"), orgId, {
      firstName: "Demo",
      lastName: "Client",
      email: DEMO_CLIENT.email,
      phone: "+15125550100",
      dob: "1985-03-14",
      ssn: "900000001",
      address: { line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
      assignedStaffId: staff?.id ?? (await orgs.orgAdmins(db, orgId))[0].id,
    });
    await clients.setClientStatus(db, orgId, clientId, "active");
    await clients.setAuthStatus(db, orgId, clientId, "signed");
    await authRepo.createAccount(db, { orgId, clientId, email: DEMO_CLIENT.email, passwordHash: hashPassword(c.env, DEMO_CLIENT.password), mfaType: "email", totpSecretEnc: null });
    // Kick off a real import so the portal and staff app have report items to show.
    const rep = await reports.createReport(db, orgId, clientId, c.env.CREDIT_PROVIDER, staff?.id ?? "system");
    try {
      const inst = await c.env.WF_IMPORT.create({ id: rep.id, params: { orgId, clientId, reportId: rep.id } });
      await reports.updateReport(db, rep.id, { workflowId: inst.id });
    } catch {
      await reports.updateReport(db, rep.id, { status: "failed", error: "Workflows unavailable" });
    }
  }

  return c.json(
    {
      orgId,
      created,
      staff: { admin: adminEmail, staff: "staff@local.test", approver: "approver@local.test", url: "/admin" },
      demoClient: { ...DEMO_CLIENT, url: "/login", mfa: "email code, printed in the pnpm dev console" },
    },
    created ? 201 : 200,
  );
});

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { letters, orgs } from "@da/db";
import { DAY } from "@da/shared";
import type { DeadlineParams, Env } from "../env";
import { letterOwner, markOverdue } from "../lib/letters";
import { dbFor, link, notify } from "../lib/services";

/**
 * One instance per sent letter (R16.2–R16.4): sleep until due−7d → remind → due−3d → remind →
 * due → overdue if no response. Logging a response terminates the instance; every step also
 * re-checks the status, so a missed terminate is harmless.
 */
export async function runDisputeDeadline(env: Env, p: DeadlineParams, step: WorkflowStep) {
  const db = dbFor(env);
  const { offsets, now } = await step.do("load", async () => {
    const org = await orgs.getOrg(db, p.orgId);
    const offsets = [...new Set(org?.settings.reminderOffsetsDays ?? [7, 3])].sort((a, b) => b - a);
    return { offsets, now: Date.now() };
  });

  for (const days of offsets) {
    const at = p.dueAt - days * DAY;
    if (at <= now) continue;
    await step.sleepUntil(`until-minus-${days}d`, at);
    await step.do(`remind-${days}d`, async () => {
      const l = await letters.getLetter(db, p.orgId, p.letterId);
      if (l?.status !== "sent") return false;
      const owner = await letterOwner(db, p.orgId, l);
      await notify(env, { id: `remind:${p.letterId}:${days}`, orgId: p.orgId, recipient: { kind: "staff", id: owner }, event: "deadline_reminder", vars: { days, link: link(env, `/admin/letters/${p.letterId}`) } });
      return true;
    });
  }

  await step.sleepUntil("until-due", p.dueAt);
  const overdue = await step.do("overdue", async () => markOverdue(env, p.orgId, p.letterId));
  return { overdue };
}

export class DisputeDeadlineWorkflow extends WorkflowEntrypoint<Env, DeadlineParams> {
  async run(event: Readonly<WorkflowEvent<DeadlineParams>>, step: WorkflowStep) {
    return runDisputeDeadline(this.env, event.payload, step);
  }
}

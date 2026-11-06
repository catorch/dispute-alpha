import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { letters } from "@da/db";
import type { Env, LetterParams } from "../env";
import { letterOwner, loadAttachments, mergeAttachments, storeLetterPdf } from "../lib/letters";
import { dbFor, fieldCrypto, link, metric, notify, opsAlert } from "../lib/services";

const RETRY = { retries: { limit: 3, delay: "20 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

/**
 * Started on approval (design decision: equivalent to waiting for the approval event).
 * render (pdf-render queue, limited concurrency, shared browser session) → attach documents →
 * save to R2 → Ready to Mail → notify (R15).
 */
export async function runLetterPipeline(env: Env, p: LetterParams, instanceId: string, step: WorkflowStep) {
  const db = dbFor(env);
  const started = await step.do("start", RETRY, async () => letters.transitionLetter(db, p.orgId, p.letterId, ["approved", "rendering"], { status: "rendering" }));
  if (!started) return { skipped: true };

  try {
    await step.do("enqueue-render", RETRY, async () => {
      await env.Q_PDF.send({ letterId: p.letterId, instanceId });
      return true;
    });
    const ev = await step.waitForEvent<{ ok: boolean; key?: string; error?: string }>("pdf-rendered", { type: "pdf-rendered", timeout: "1 hour" });
    if (!ev.payload.ok || !ev.payload.key) throw new Error(ev.payload.error ?? "render failed");
    const bodyKey = ev.payload.key;

    const docId = await step.do("attach-and-store", RETRY, async () => {
      const l = await letters.getLetter(db, p.orgId, p.letterId);
      if (!l) throw new Error("letter not found");
      const obj = await env.LETTERS.get(bodyKey);
      if (!obj) throw new Error("rendered body missing");
      const merged = await mergeAttachments(new Uint8Array(await obj.arrayBuffer()), await loadAttachments(env, fieldCrypto(env), p.orgId, p.letterId));
      // Deterministic id keeps a retried step from creating a second document.
      return storeLetterPdf(env, l, merged, `letterpdf-${instanceId}`);
    });

    await step.do("ready", RETRY, async () => {
      const l = await letters.getLetter(db, p.orgId, p.letterId);
      if (!l) throw new Error("letter not found");
      await letters.transitionLetter(db, p.orgId, p.letterId, "rendering", { status: "ready_to_mail", pdfDocumentId: docId });
      const owner = await letterOwner(db, p.orgId, l);
      await notify(env, { id: `ready:${p.letterId}:${instanceId}`, orgId: p.orgId, recipient: { kind: "staff", id: owner }, event: "letter_ready", vars: { link: link(env, `/admin/letters/${p.letterId}`) } });
      metric(env, "letter_ready", p.orgId);
      return true;
    });
    return { documentId: docId };
  } catch (e) {
    await step.do("fail", async () => {
      await renderFailed(env, p, String(e instanceof Error ? e.message : e));
      return true;
    });
    return { failed: true };
  }
}

/** R15.3: letter shows render_failed with a retry action; author and ops are told. */
export async function renderFailed(env: Env, p: LetterParams, reason: string) {
  const db = dbFor(env);
  const applied = await letters.transitionLetter(db, p.orgId, p.letterId, ["rendering", "approved"], { status: "render_failed" });
  if (!applied) return;
  const l = await letters.getLetter(db, p.orgId, p.letterId);
  if (l) {
    const owner = await letterOwner(db, p.orgId, l);
    await notify(env, { id: `render-failed:${p.letterId}:${Date.now()}`, orgId: p.orgId, recipient: { kind: "staff", id: owner }, event: "render_failed", vars: { link: link(env, `/admin/letters/${p.letterId}`) } });
  }
  await opsAlert(env, "Letter PDF render failed", `letter=${p.letterId} reason=${reason.slice(0, 300)}`);
}

export class LetterPipelineWorkflow extends WorkflowEntrypoint<Env, LetterParams> {
  async run(event: Readonly<WorkflowEvent<LetterParams>>, step: WorkflowStep) {
    return runLetterPipeline(this.env, event.payload, event.instanceId, step);
  }
}

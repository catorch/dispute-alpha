import { DurableObject } from "cloudflare:workers";
import type { LockState } from "@da/shared";

/** Edit lease per client (R14.9): one editor at a time for dispute rounds and letters. */
export const LEASE_MS = 5 * 60_000;
type Holder = { id: string; name: string; expiresAt: number };

export class ClientLock extends DurableObject {
  private async holder(): Promise<Holder | null> {
    const h = await this.ctx.storage.get<Holder>("holder");
    if (h && h.expiresAt <= Date.now()) {
      await this.ctx.storage.delete("holder");
      return null;
    }
    return h ?? null;
  }

  /** Acquires or renews the lease. Another user's live lease wins. */
  async acquire(user: { id: string; name: string }): Promise<LockState> {
    const h = await this.holder();
    if (h && h.id !== user.id) return { ok: false, holder: { id: h.id, name: h.name }, expiresAt: h.expiresAt };
    const expiresAt = Date.now() + LEASE_MS;
    await this.ctx.storage.put("holder", { ...user, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
    return { ok: true, expiresAt };
  }

  async release(userId: string): Promise<void> {
    const h = await this.holder();
    if (h?.id === userId) await this.ctx.storage.delete("holder");
  }

  /** Who holds the lease, if anyone. */
  async state(): Promise<Holder | null> {
    return this.holder();
  }

  async alarm() {
    await this.holder(); // clears an expired lease
  }
}

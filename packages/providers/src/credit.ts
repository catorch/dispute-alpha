import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "@da/crypto";
import type { Bureau, ItemType } from "@da/shared";

export type ClientIdentity = { firstName: string; lastName: string; ssn: string; dob: string; address: { line1: string; city: string; state: string; zip: string } };
export type RawReport = { providerRef: string; bureaus: Partial<Record<Bureau, RawBureau>> };
export type RawBureau = {
  personal?: { firstName?: string; lastName?: string; addressLine1?: string; zip?: string; dob?: string }[];
  tradelines?: RawAccount[];
  collections?: RawAccount[];
  inquiries?: { creditor: string; date: string; type?: "hard" | "soft" }[];
  publicRecords?: { type: string; court?: string; filedDate: string; status?: string; amount?: number }[];
};
export type RawAccount = {
  creditor: string;
  accountNumber?: string;
  balance?: number;
  creditLimit?: number;
  openedDate?: string;
  reportedDate?: string;
  status?: string;
  paymentHistory?: string[];
  lastLateDate?: string;
  originalCreditor?: string;
};

export type NormalizedItem = {
  bureau: Bureau;
  itemType: ItemType;
  furnisher: string | null;
  accountNumber: string | null;
  accountMask: string | null;
  balance: number | null;
  creditLimit: number | null;
  openedAt: string | null;
  reportedAt: string | null;
  status: string | null;
  paymentHistoryJson: string | null;
  detailsJson: string;
  fingerprint: string;
};

export type CreditWebhookEvent = { eventId: string; providerRef: string; type: "report_ready" | "report_failed" };

/** Adapter for the credit monitoring provider (vendor pending decision D6). */
export interface CreditProvider {
  readonly name: string;
  requestReport(client: ClientIdentity, idempotencyKey: string): Promise<{ providerRef: string }>;
  fetchReport(providerRef: string): Promise<RawReport | "pending">;
  verifyWebhook(req: Request): Promise<CreditWebhookEvent | null>;
}

export const maskAccount = (n?: string | null) => (n ? `****${n.replace(/\D/g, "").slice(-4) || n.slice(-4)}` : null);
const normFurnisher = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/** Stable across imports for the same tradeline, used to compare imports over time (R13.4, design decision). */
export const fingerprint = (bureau: string, type: string, furnisher: string | null, mask: string | null, opened: string | null) =>
  sha256Hex([bureau, type, normFurnisher(furnisher ?? ""), mask ?? "", opened ?? ""].join("|")).then((h) => h.slice(0, 32));

/** Converts one bureau of a raw report into report_item rows (R12.4). */
export async function normalizeBureau(raw: RawReport, bureau: Bureau): Promise<NormalizedItem[]> {
  const b = raw.bureaus[bureau];
  if (!b) return [];
  const out: NormalizedItem[] = [];
  const push = async (i: Omit<NormalizedItem, "fingerprint" | "bureau">) =>
    out.push({ ...i, bureau, fingerprint: await fingerprint(bureau, i.itemType, i.furnisher, i.accountMask, i.openedAt) });
  const account = (a: RawAccount, itemType: ItemType) =>
    push({
      itemType,
      furnisher: a.creditor,
      accountNumber: a.accountNumber ?? null,
      accountMask: maskAccount(a.accountNumber),
      balance: a.balance ?? null,
      creditLimit: a.creditLimit ?? null,
      openedAt: a.openedDate ?? null,
      reportedAt: a.reportedDate ?? null,
      status: a.status ?? null,
      paymentHistoryJson: a.paymentHistory ? JSON.stringify(a.paymentHistory) : null,
      detailsJson: JSON.stringify({ lastLateAt: a.lastLateDate ?? null, originalCreditor: a.originalCreditor ?? null }),
    });
  for (const a of b.tradelines ?? []) await account(a, "tradeline");
  for (const a of b.collections ?? []) await account(a, "collection");
  for (const q of b.inquiries ?? [])
    await push({ itemType: "inquiry", furnisher: q.creditor, accountNumber: null, accountMask: null, balance: null, creditLimit: null, openedAt: null, reportedAt: q.date, status: null, paymentHistoryJson: null, detailsJson: JSON.stringify({ inquiryType: q.type ?? "hard" }) });
  for (const p of b.publicRecords ?? [])
    await push({ itemType: "public_record", furnisher: p.court ?? p.type, accountNumber: null, accountMask: null, balance: p.amount ?? null, creditLimit: null, openedAt: null, reportedAt: p.filedDate, status: p.status ?? null, paymentHistoryJson: null, detailsJson: JSON.stringify({ recordType: p.type }) });
  for (const [i, p] of (b.personal ?? []).entries())
    await push({
      itemType: "personal_info",
      furnisher: i === 0 ? "Name and address on file" : `Name and address on file (${i + 1})`,
      accountNumber: null,
      accountMask: null,
      balance: null,
      creditLimit: null,
      openedAt: null,
      reportedAt: null,
      status: null,
      paymentHistoryJson: null,
      // DOB is never copied out of the encrypted raw payload.
      detailsJson: JSON.stringify({ firstName: p.firstName ?? null, lastName: p.lastName ?? null, addressLine1: p.addressLine1 ?? null, zip: p.zip ?? null }),
    });
  return out;
}

/**
 * Deterministic provider for local, staging, and tests. Returns a realistic tri-bureau report
 * seeded from the client's name, with items that trip each default flag rule.
 * `pendingPolls` makes fetchReport return "pending" that many times per report.
 */
export class FakeCreditProvider implements CreditProvider {
  readonly name = "fake";
  private polls = new Map<string, number>();
  constructor(private opts: { webhookSecret?: string; pendingPolls?: number; failRequests?: number } = {}) {}
  private failures = 0;

  async requestReport(c: ClientIdentity, idempotencyKey: string) {
    if (this.failures < (this.opts.failRequests ?? 0)) {
      this.failures++;
      throw new Error("Fake provider unavailable");
    }
    return { providerRef: `fake:${idempotencyKey}:${encodeURIComponent(c.lastName)}:${c.address.zip}` };
  }

  async fetchReport(providerRef: string): Promise<RawReport | "pending"> {
    const n = this.polls.get(providerRef) ?? 0;
    if (n < (this.opts.pendingPolls ?? 0)) {
      this.polls.set(providerRef, n + 1);
      return "pending";
    }
    const [, , lastName = "Doe", zip = "00000"] = providerRef.split(":");
    return fakeReport(providerRef, decodeURIComponent(lastName), zip);
  }

  async verifyWebhook(req: Request): Promise<CreditWebhookEvent | null> {
    const secret = this.opts.webhookSecret;
    const sig = req.headers.get("x-fake-signature") ?? "";
    const body = await req.text();
    if (!secret || !timingSafeEqual(sig, await hmacSha256Hex(secret, body))) return null;
    const j = JSON.parse(body) as CreditWebhookEvent;
    return j.eventId && j.providerRef ? j : null;
  }
}

export function fakeReport(providerRef: string, lastName: string, zip: string): RawReport {
  const personal = [{ firstName: "Client", lastName, addressLine1: "1 Main St", zip }];
  const shared: RawAccount = { creditor: "Capital Bank", accountNumber: "4111111111111234", creditLimit: 5000, openedDate: "2019-04-01", reportedDate: "2026-10-01", status: "Open", paymentHistory: ["OK", "OK", "30", "OK"] };
  return {
    providerRef,
    bureaus: {
      equifax: {
        personal,
        tradelines: [
          { ...shared, balance: 1200 },
          { creditor: "Old Auto Loans", accountNumber: "77005521", balance: 0, openedDate: "2012-02-01", reportedDate: "2019-01-01", status: "Closed - Late 90", lastLateDate: "2017-05-01" },
        ],
        collections: [{ creditor: "Midwest Recovery", accountNumber: "C-99881", balance: 0, openedDate: "2021-06-01", reportedDate: "2026-09-01", status: "Collection", originalCreditor: "City Medical" }],
        inquiries: [{ creditor: "QuickCash Lending", date: "2026-03-15", type: "hard" }],
      },
      experian: {
        personal: [{ firstName: "Client", lastName: "Smith", addressLine1: "9 Elm St", zip: "99999" }],
        tradelines: [{ ...shared, balance: 2400 }],
        publicRecords: [{ type: "Civil judgment", court: "County Court", filedDate: "2016-08-01", status: "Satisfied", amount: 1500 }],
      },
      transunion: {
        personal,
        tradelines: [{ ...shared, balance: 1200 }],
        inquiries: [{ creditor: "Prequal Offers", date: "2026-01-10", type: "soft" }],
      },
    },
  };
}

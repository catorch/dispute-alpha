import { type DB, letters, parseJson } from "@da/db";
import { type Address, DEFERRED_FIELDS, MergeFieldError, type OrgSettings, AppError, isoDay, renderTemplate } from "@da/shared";

type ClientRow = { firstName: string; lastName: string; addressJson: string; ssnLast4: string };
type ItemRow = { furnisher: string | null; accountMask: string | null; bureau: string; itemType: string; status: string | null; balance: number | null };

export const BUREAU_NAMES: Record<string, string> = {
  equifax: "Equifax Information Services LLC",
  experian: "Experian",
  transunion: "TransUnion LLC",
};

export const addressBlock = (a: Address) => [a.line1, ...(a.line2 ? [a.line2] : []), `${a.city}, ${a.state} ${a.zip}`];

/** Merge context for a draft. DOB stays a token until PDF render so it is never stored in D1 (R6.1). */
export function draftContext(client: ClientRow, settings: OrgSettings, target: string, round: number, items: (ItemRow & { reason: string })[]) {
  const address = parseJson<Address>(client.addressJson, { line1: "", city: "", state: "", zip: "" });
  return {
    client: {
      first_name: client.firstName,
      last_name: client.lastName,
      full_name: `${client.firstName} ${client.lastName}`,
      address_block: addressBlock(address),
      ssn_last4: client.ssnLast4,
    },
    sender: { name: settings.senderBlock.name, address_block: settings.senderBlock.addressLines },
    target: { name: target },
    date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" }),
    round: { number: round },
    items: items.map((i) => ({
      furnisher: i.furnisher ?? "",
      account_mask: i.accountMask ?? "",
      bureau: BUREAU_NAMES[i.bureau] ?? i.bureau,
      type: i.itemType.replace(/_/g, " "),
      status: i.status ?? "",
      balance: i.balance == null ? "" : `$${i.balance.toFixed(2)}`,
      reason: i.reason,
    })),
  };
}

export function renderDraft(templateHtml: string, ctx: Record<string, unknown>) {
  try {
    return renderTemplate(templateHtml, ctx, { defer: DEFERRED_FIELDS });
  } catch (e) {
    if (e instanceof MergeFieldError) throw new AppError("template_invalid", 422, e.message);
    throw e;
  }
}

export const today = () => isoDay(Date.now());

/** Loads a letter or throws 404, always org-scoped. */
export async function loadLetter(db: DB, orgId: string, id: string) {
  const l = await letters.getLetter(db, orgId, id);
  if (!l) throw new AppError("not_found", 404, "Letter not found");
  return l;
}

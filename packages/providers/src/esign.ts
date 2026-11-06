import { hmacSha256Hex, timingSafeEqual } from "@da/crypto";

export type EsignEvent = { eventId: string; providerRequestId: string; type: "signed" | "declined" | "expired" | "other" };

/** E-signature adapter for client authorization packets (R11). */
export interface ESignProvider {
  readonly name: string;
  createRequest(r: { signerName: string; signerEmail: string; templateId: string; metadata: Record<string, string> }): Promise<{ providerRequestId: string }>;
  verifyWebhook(req: Request): Promise<EsignEvent | null>;
  downloadSigned(providerRequestId: string): Promise<Uint8Array>;
  /** Body the provider expects in the webhook response. */
  readonly webhookAck: string;
}

/** Dropbox Sign (HelloSign) API v3. */
export class DropboxSignProvider implements ESignProvider {
  readonly name = "dropbox_sign";
  readonly webhookAck = "Hello API Event Received";
  constructor(
    private apiKey: string,
    private opts: { testMode?: boolean; fetcher?: typeof fetch; baseUrl?: string } = {},
  ) {}
  private get f() {
    return this.opts.fetcher ?? fetch;
  }
  private get auth() {
    return `Basic ${btoa(`${this.apiKey}:`)}`;
  }
  private get base() {
    return this.opts.baseUrl ?? "https://api.hellosign.com/v3";
  }

  async createRequest(r: { signerName: string; signerEmail: string; templateId: string; metadata: Record<string, string> }) {
    const form = new FormData();
    form.set("template_ids[0]", r.templateId);
    form.set("signers[Client][name]", r.signerName);
    form.set("signers[Client][email_address]", r.signerEmail);
    for (const [k, v] of Object.entries(r.metadata)) form.set(`metadata[${k}]`, v);
    if (this.opts.testMode) form.set("test_mode", "1");
    const res = await this.f(`${this.base}/signature_request/send_with_template`, { method: "POST", headers: { Authorization: this.auth }, body: form });
    if (!res.ok) throw new Error(`Dropbox Sign error ${res.status}`);
    const j = (await res.json()) as { signature_request: { signature_request_id: string } };
    return { providerRequestId: j.signature_request.signature_request_id };
  }

  /** event_hash = HMAC-SHA256(api_key, event_time + event_type). */
  async verifyWebhook(req: Request): Promise<EsignEvent | null> {
    const form = await req.formData();
    const raw = form.get("json");
    if (typeof raw !== "string") return null;
    const j = JSON.parse(raw) as { event: { event_time: string; event_type: string; event_hash: string }; signature_request?: { signature_request_id: string } };
    const expected = await hmacSha256Hex(this.apiKey, j.event.event_time + j.event.event_type);
    if (!timingSafeEqual(expected, j.event.event_hash)) return null;
    const id = j.signature_request?.signature_request_id ?? "";
    const type = ({ signature_request_all_signed: "signed", signature_request_declined: "declined", signature_request_expired: "expired" } as const)[j.event.event_type as "signature_request_all_signed"] ?? "other";
    return { eventId: `${id}:${j.event.event_type}:${j.event.event_time}`, providerRequestId: id, type };
  }

  async downloadSigned(id: string) {
    const res = await this.f(`${this.base}/signature_request/files/${encodeURIComponent(id)}?file_type=pdf`, { headers: { Authorization: this.auth } });
    if (!res.ok) throw new Error(`Dropbox Sign download error ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Local/staging/test provider. Webhooks are JSON signed with HMAC in `x-fake-signature`. */
export class FakeESignProvider implements ESignProvider {
  readonly name = "fake";
  readonly webhookAck = "ok";
  constructor(private secret = "fake-esign-secret") {}
  async createRequest(r: { metadata: Record<string, string> }) {
    return { providerRequestId: `fake-sig-${r.metadata.client_id ?? crypto.randomUUID()}-${Date.now()}` };
  }
  async verifyWebhook(req: Request) {
    const body = await req.text();
    if (!timingSafeEqual(req.headers.get("x-fake-signature") ?? "", await hmacSha256Hex(this.secret, body))) return null;
    return JSON.parse(body) as EsignEvent;
  }
  async downloadSigned() {
    return new TextEncoder().encode("%PDF-1.4\n% fake signed authorization\n%%EOF\n");
  }
}

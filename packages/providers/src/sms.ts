import { b64, timingSafeEqual } from "@da/crypto";

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

export class TwilioSmsSender implements SmsSender {
  constructor(
    private accountSid: string,
    private authToken: string,
    private from: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(to: string, body: string) {
    const res = await this.fetcher(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: this.from, Body: body }),
    });
    if (!res.ok) throw new Error(`Twilio error ${res.status}`);
  }
}

export class MemorySmsSender implements SmsSender {
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
  }
}

/** X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + sorted(key+value))). */
export async function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
  return timingSafeEqual(sig, signature);
}
export const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];

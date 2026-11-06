export type EmailMessage = { to: string; subject: string; text: string; html?: string };

/** One interface, two real implementations selected by EMAIL_PROVIDER (R18.3). */
export interface EmailSender {
  send(m: EmailMessage): Promise<void>;
}

type SendEmailBinding = { send(m: { from: string; to: string; subject: string; text?: string; html?: string }): Promise<unknown> };

export class CloudflareEmailSender implements EmailSender {
  constructor(
    private binding: SendEmailBinding,
    private from: string,
  ) {}
  async send(m: EmailMessage) {
    await this.binding.send({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  }
}

export class PostmarkEmailSender implements EmailSender {
  constructor(
    private token: string,
    private from: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(m: EmailMessage) {
    const res = await this.fetcher("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ From: this.from, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: "outbound" }),
    });
    if (!res.ok) throw new Error(`Postmark error ${res.status}`);
  }
}

/** Local development only: records messages instead of sending. */
export class MemoryEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    console.log(`[email:local] to=${m.to} subject=${m.subject}\n${m.text}`);
  }
}

export const htmlFromText = (t: string) =>
  `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>")}</div>`;

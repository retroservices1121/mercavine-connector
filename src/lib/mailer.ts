/**
 * Outbound mail. Provider order:
 *   1. RESEND_API_KEY      -> Resend HTTPS API (fetch, no SDK)
 *   2. SMTP is not supported (needs a socket client); use an HTTPS provider
 *   3. none, non-production -> in-memory outbox (tests) + console line without the link
 *   4. none, production     -> warning without the link; mail is NOT delivered
 */
export type Mail = { to: string; subject: string; text: string; html?: string; tag?: string };
export type SentMail = Mail & { from: string; reply_to: string; provider: "resend" | "outbox" | "none"; at: string };

export const MAIL_FROM = process.env.MAIL_FROM?.trim() || "Mercavine <no-reply@mercavine.com>";
export const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO?.trim() || "privacy@mercavine.com";

const outbox: SentMail[] = [];

export function mailOutbox(): readonly SentMail[] {
  return outbox;
}

export function clearMailOutbox() {
  outbox.length = 0;
}

export function mailProvider(): "resend" | "none" {
  return process.env.RESEND_API_KEY?.trim() ? "resend" : "none";
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean; provider: SentMail["provider"] }> {
  const base = { ...mail, from: MAIL_FROM, reply_to: MAIL_REPLY_TO, at: new Date().toISOString() };
  if (mailProvider() === "resend") {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ from: MAIL_FROM, to: [mail.to], reply_to: MAIL_REPLY_TO, subject: mail.subject, text: mail.text, html: mail.html }),
      });
      if (!res.ok) {
        console.warn(`[mailer] resend rejected ${mail.tag ?? "mail"}: HTTP ${res.status}`);
        return { delivered: false, provider: "resend" };
      }
      return { delivered: true, provider: "resend" };
    } catch {
      console.warn(`[mailer] resend request failed for ${mail.tag ?? "mail"}`);
      return { delivered: false, provider: "resend" };
    }
  }
  if (process.env.NODE_ENV === "production") {
    console.warn(`[mailer] no email provider configured; ${mail.tag ?? "mail"} not delivered. Set RESEND_API_KEY.`);
    return { delivered: false, provider: "none" };
  }
  outbox.push({ ...base, provider: "outbox" });
  console.log(`[mailer] outbox: ${mail.tag ?? "mail"} -> ${mail.to} (${mail.subject})`);
  return { delivered: true, provider: "outbox" };
}

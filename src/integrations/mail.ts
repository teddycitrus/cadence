import { ValidationError } from "../core/errors";
import type { SecretStore } from "./secrets";

export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS from the start (port 465); otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user: string;
  pass: string;
  /** The sender, like "Cadence <cadence@example.com>". */
  from: string;
}

export interface MailStatus {
  configured: boolean;
  host: string | null;
  from: string | null;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const KEY = "smtp";
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Sends this organization's email (invites) through its own SMTP server. */
export class Mailer {
  constructor(private secrets: SecretStore) {}

  private settings(): SmtpSettings | null {
    const raw = this.secrets.get(KEY);
    return raw ? (JSON.parse(raw) as SmtpSettings) : null;
  }

  status(): MailStatus {
    const s = this.settings();
    return { configured: Boolean(s), host: s?.host ?? null, from: s?.from ?? null };
  }

  /** The SMTP client, loaded on first use: most servers never send mail. */
  private async transport(s: SmtpSettings) {
    const { default: nodemailer } = await import("nodemailer");
    return nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined, connectionTimeout: 15_000, greetingTimeout: 15_000 });
  }

  /** Saves settings after checking the server accepts them; null clears them. */
  async save(input: SmtpSettings | null): Promise<MailStatus> {
    if (!input) {
      this.secrets.set(KEY, null);
      return this.status();
    }
    // An empty password keeps the saved one, so the form never has to show it.
    const pass = input.pass || this.settings()?.pass || "";
    const s = { ...input, pass };
    try {
      await (await this.transport(s)).verify();
    } catch (err) {
      throw new ValidationError(`The mail server refused the settings: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.secrets.set(KEY, JSON.stringify(s));
    return this.status();
  }

  async send(mail: OutgoingMail): Promise<void> {
    const s = this.settings();
    if (!s) throw new ValidationError("Set up email in Settings > Members first");
    if (!EMAIL.test(mail.to)) throw new ValidationError(`"${mail.to}" is not an email address`);
    try {
      await (await this.transport(s)).sendMail({ from: s.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (err) {
      throw new ValidationError(`Could not send the email: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The invite email: who asked, which organization, and the link. */
  inviteMail(input: { to: string; orgName: string; inviter: string; role: string; link: string; expiresAt: string }): OutgoingMail {
    const until = new Date(input.expiresAt).toUTCString();
    const text = [`${input.inviter} invited you to join ${input.orgName} on Cadence as ${input.role === "admin" ? "an admin" : "a member"}.`, "", `Accept the invite: ${input.link}`, "", `The link works once and expires ${until}.`].join("\n");
    const html = `<p>${escape(input.inviter)} invited you to join <strong>${escape(input.orgName)}</strong> on Cadence as ${input.role === "admin" ? "an admin" : "a member"}.</p><p><a href="${escape(input.link)}">Accept the invite</a></p><p style="color:#71717a;font-size:12px">The link works once and expires ${escape(until)}.</p>`;
    return { to: input.to, subject: `Join ${input.orgName} on Cadence`, text, html };
  }
}

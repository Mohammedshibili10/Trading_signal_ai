import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Email delivery.
 *
 * Falls back to a console transport when SMTP isn't configured, so registration
 * and password reset work end-to-end in development — the verification link is
 * printed to the log rather than swallowed. A silent no-op here would make the
 * reset flow appear broken.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const mail = this.config.get<{
      host: string;
      port: number;
      user: string;
      password: string;
      enabled: boolean;
    }>('mail');

    if (!mail?.enabled) {
      this.logger.log('SMTP not configured — emails will be written to the log');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.port === 465,
      auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    });
    this.enabled = true;
    this.logger.log(`SMTP transport ready (${mail.host}:${mail.port})`);
  }

  async send(message: MailMessage): Promise<void> {
    const from = this.config.get<string>('mail.from');

    if (!this.enabled || !this.transporter) {
      this.logger.log(
        `\n${'─'.repeat(70)}\n` +
          `EMAIL (console transport — set SMTP_HOST to send for real)\n` +
          `To:      ${message.to}\n` +
          `Subject: ${message.subject}\n\n` +
          `${message.text}\n${'─'.repeat(70)}`,
      );
      return;
    }

    try {
      await this.transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html ?? this.wrapHtml(message.subject, message.text),
      });
    } catch (error) {
      // A failed email must not fail the request that triggered it — the user
      // has already been created, and they can request another link.
      this.logger.error(
        `failed to send "${message.subject}" to ${message.to}: ${(error as Error).message}`,
      );
    }
  }

  private wrapHtml(subject: string, text: string): string {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')
      .replace(/\n/g, '<br>');

    return `<!doctype html><html><body style="margin:0;padding:32px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c2024">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;border:1px solid #e6e8eb">
<h1 style="margin:0 0 20px;font-size:18px;font-weight:600">${subject}</h1>
<div style="font-size:14px;line-height:1.65;color:#3c4147">${escaped}</div>
<hr style="margin:28px 0 16px;border:none;border-top:1px solid #e6e8eb">
<p style="margin:0;font-size:12px;color:#8b9096">
AI Trading Intelligence — analysis software, not investment advice.
</p></div></body></html>`;
  }
}

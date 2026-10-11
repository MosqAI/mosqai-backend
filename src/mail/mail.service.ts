import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends email through SMTP_URL. Without it (local development) messages are
 * written to `.outbox/` instead and nothing leaves the machine; `sent` tells
 * callers which happened.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private readonly transport?: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.SMTP_URL) this.transport = nodemailer.createTransport(env.SMTP_URL);
  }

  get configured() {
    return Boolean(this.transport);
  }

  async send(mail: Mail): Promise<{ sent: boolean }> {
    if (this.transport) {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, ...mail });
      return { sent: true };
    }
    const dir = join(process.cwd(), '.outbox');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mail.to.replace(/[^a-z0-9@.-]/gi, '_')}.html`);
    await writeFile(file, `<!-- To: ${mail.to} | Subject: ${mail.subject} -->\n${mail.html}`);
    this.log.warn(`SMTP_URL not set: email to ${mail.to} saved to ${file}`);
    return { sent: false };
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}

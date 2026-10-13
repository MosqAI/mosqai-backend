import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators.js';
import { publicUser } from '../auth/auth.service.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.module.js';

const STAFF_ROLES = ['ADMIN', 'AUTHORITY_ADMIN', 'AUTHORITY_VIEWER'] as const;

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email(),
  role: z.enum(STAFF_ROLES),
  language: z.enum(['en', 'fr', 'rw']).default('en'),
});
const updateSchema = z
  .object({ role: z.enum(STAFF_ROLES).optional(), active: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.active !== undefined, 'Nothing to update');

// No look-alike characters (0/O, 1/l/I) so the password survives being read off an email.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const temporaryPassword = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

const ROLE_LABEL: Record<(typeof STAFF_ROLES)[number], string> = {
  ADMIN: 'Super admin',
  AUTHORITY_ADMIN: 'Authority admin',
  AUTHORITY_VIEWER: 'Authority viewer',
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Staff accounts only; device owners are never listed here. */
  async list() {
    const users = await this.prisma.user.findMany({ where: { role: { not: 'OWNER' } }, orderBy: { name: 'asc' } });
    return users.map(publicUser);
  }

  async create(actor: AuthUser, input: z.infer<typeof createSchema>) {
    const email = input.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('An account with this email already exists');
    const password = temporaryPassword();
    const user = await this.prisma.user.create({
      data: {
        name: input.name,
        email,
        role: input.role,
        language: input.language,
        passwordHash: await bcrypt.hash(password, 10),
        mustChangePassword: true,
      },
    });
    await this.audit(actor, 'user.create', user, { role: user.role });
    const delivery = await this.sendCredentials(user, password, false);
    return this.result(user, password, delivery.sent);
  }

  async update(actor: AuthUser, id: string, input: z.infer<typeof updateSchema>) {
    if (id === actor.id) throw new BadRequestException('You cannot change your own role or access');
    const existing = await this.find(id);
    const user = await this.prisma.user.update({ where: { id: existing.id }, data: input });
    // Losing access ends every session at once.
    if (input.active === false) await this.revokeSessions(id);
    await this.audit(actor, 'user.update', user, input);
    return publicUser(user);
  }

  /** Issues a new temporary password, signs the person out everywhere and emails them. */
  async resetPassword(actor: AuthUser, id: string) {
    const existing = await this.find(id);
    const password = temporaryPassword();
    const user = await this.prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true },
    });
    await this.revokeSessions(id);
    await this.audit(actor, 'user.reset_password', user, {});
    const delivery = await this.sendCredentials(user, password, true);
    return this.result(user, password, delivery.sent);
  }

  private async find(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role === 'OWNER') throw new NotFoundException('User not found');
    return user;
  }

  private revokeSessions(userId: string) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  private audit(actor: AuthUser, action: string, target: User, data: object) {
    return this.prisma.auditLog.create({ data: { actorId: actor.id, action, target: target.id, data } });
  }

  /**
   * The temporary password is returned to the admin only when no email could be
   * sent (SMTP not configured), so they can hand it over another way.
   */
  private result(user: User, password: string, emailed: boolean) {
    return { user: publicUser(user), emailed, ...(!emailed && { temporaryPassword: password }) };
  }

  private sendCredentials(user: User, password: string, reset: boolean) {
    const url = this.env.WEB_APP_URL;
    const role = ROLE_LABEL[user.role as keyof typeof ROLE_LABEL];
    const intro = reset
      ? 'Your MosqAI Shield password has been reset by an administrator.'
      : `An account has been created for you on the MosqAI Shield authority dashboard, with the role ${role}.`;
    const text = `Hello ${user.name},

${intro}

Sign in at ${url}/login
Email: ${user.email}
Temporary password: ${password}

You will be asked to choose your own password when you first sign in. If you were not expecting this email, you can ignore it.

MosqAI Shield · Beyond the Capture.`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#241544;max-width:520px;margin:0 auto;padding:32px 24px;line-height:1.55">
  <p style="font-size:18px;font-weight:700;margin:0 0 24px">MosqAI <span style="color:#7b3fe4">Shield</span></p>
  <p>Hello ${escapeHtml(user.name)},</p>
  <p>${escapeHtml(intro)}</p>
  <table style="margin:20px 0;padding:16px 20px;background:#f7f3fd;border-radius:10px;font-size:14px">
    <tr><td style="color:#57506e;padding:2px 16px 2px 0">Email</td><td><strong>${escapeHtml(user.email)}</strong></td></tr>
    <tr><td style="color:#57506e;padding:2px 16px 2px 0">Temporary password</td><td><strong style="font-family:Consolas,monospace;letter-spacing:1px">${password}</strong></td></tr>
  </table>
  <p><a href="${url}/login" style="display:inline-block;background:#7b3fe4;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Sign in</a></p>
  <p style="color:#57506e;font-size:13px">You will be asked to choose your own password when you first sign in. If you were not expecting this email, you can ignore it.</p>
  <p style="color:#9894ab;font-size:12px;margin-top:32px;letter-spacing:2px">BEYOND THE CAPTURE.</p>
</div>`;
    return this.mail.send({ to: user.email, subject: reset ? 'Your new MosqAI Shield password' : 'Your MosqAI Shield account', text, html });
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Staff account management: super admins only. */
@Controller('users')
@Roles('ADMIN')
class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return this.users.create(actor, body);
  }

  @Patch(':id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>) {
    return this.users.update(actor, id, body);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.users.resetPassword(actor, id);
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}

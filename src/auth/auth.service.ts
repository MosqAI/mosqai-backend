import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { ENV, type Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.module.js';

// Compared against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  phone: u.phone,
  language: u.language,
  role: u.role,
  active: u.active,
  mustChangePassword: u.mustChangePassword,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Self-service sign-up creates device owners only; staff accounts are created by admins. */
  async register(input: {
    name: string;
    email: string;
    phone?: string;
    password: string;
    language?: string;
  }) {
    const email = input.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('An account with this email already exists');
    }
    const user = await this.prisma.user.create({
      data: {
        name: input.name,
        email,
        phone: input.phone,
        language: input.language,
        role: 'OWNER',
        passwordHash: await bcrypt.hash(input.password, 10),
        lastLoginAt: new Date(),
      },
    });
    return this.issueTokens(user);
  }

  async updateProfile(
    userId: string,
    data: { name?: string; phone?: string | null; language?: string },
  ) {
    return publicUser(
      await this.prisma.user.update({ where: { id: userId }, data }),
    );
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.active)
      throw new UnauthorizedException('Invalid email or password');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.issueTokens(user);
  }

  /** Rotates the refresh token: the old one is revoked and a new pair issued. */
  async refresh(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt < new Date() ||
      !stored.user.active
    ) {
      // Reuse of a revoked token suggests theft: revoke the whole family for this user.
      if (stored?.revokedAt) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException();
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Replaces the password (required after an admin-issued temporary one); other sessions are signed out. */
  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(current, user.passwordHash)))
      throw new UnauthorizedException('Current password is incorrect');
    if (current === next)
      throw new BadRequestException('Choose a password different from the current one');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(next, 10), mustChangePassword: false },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(updated);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return publicUser(user);
  }

  private async issueTokens(user: User) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      { expiresIn: this.env.JWT_ACCESS_TTL },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL * 1000),
      },
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: this.env.JWT_ACCESS_TTL,
      user: publicUser(user),
    };
  }
}

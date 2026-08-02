import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import type { JwtPayload } from './dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends TokenPair {
  user: SafeUser;
}

export type SafeUser = Omit<User, 'passwordHash'> & {
  preferences?: unknown;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Argon2id parameters.
   *
   * 64 MiB / 3 passes is the OWASP-recommended baseline. Deliberately not
   * tuned down for speed — login is not a hot path, and a fast password hash is
   * a liability the day the database leaks.
   */
  private readonly hashOptions: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  // ── Registration ───────────────────────────────────────────────

  async register(
    email: string,
    name: string,
    password: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<AuthResult> {
    const normalised = email.toLowerCase().trim();

    const existing = await this.prisma.user.findUnique({ where: { email: normalised } });
    if (existing) {
      // Registration is one of the few places where leaking existence is
      // unavoidable — you cannot create a duplicate account silently. Login and
      // password reset both stay opaque.
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await argon2.hash(password, this.hashOptions);

    const user = await this.prisma.user.create({
      data: {
        email: normalised,
        name: name.trim(),
        passwordHash,
        provider: 'LOCAL',
        preferences: { create: {} },
        subscription: { create: { tier: 'FREE' } },
        watchlists: {
          create: { name: 'My Watchlist', isDefault: true },
        },
      },
      include: { preferences: true },
    });

    await this.sendVerificationEmail(user.id, user.email, user.name);
    await this.audit(user.id, 'auth.register', meta);

    return this.issueTokens(user, meta);
  }

  // ── Login ──────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<AuthResult> {
    const normalised = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email: normalised },
      include: { preferences: true },
    });

    // Hash against a dummy even when the user doesn't exist, so the response
    // time doesn't reveal which emails are registered.
    if (!user?.passwordHash) {
      await argon2.hash(password, this.hashOptions).catch(() => undefined);
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) {
      await this.audit(user.id, 'auth.login_failed', meta);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit(user.id, 'auth.login', meta);

    return this.issueTokens(user, meta);
  }

  // ── Google OAuth ───────────────────────────────────────────────

  async validateGoogleUser(
    profile: { email: string; name: string; providerId: string; avatarUrl?: string },
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<AuthResult> {
    const email = profile.email.toLowerCase().trim();
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { preferences: true },
    });

    if (user) {
      // Link Google to an existing local account rather than erroring. The
      // email is already verified by Google, so this is safe and it avoids a
      // dead end for users who registered with a password first.
      if (user.provider === 'LOCAL' && !user.providerId) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            providerId: profile.providerId,
            emailVerified: true,
            avatarUrl: user.avatarUrl ?? profile.avatarUrl,
            lastLoginAt: new Date(),
          },
          include: { preferences: true },
        });
      } else {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
          include: { preferences: true },
        });
      }
    } else {
      user = await this.prisma.user.create({
        data: {
          email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          provider: 'GOOGLE',
          providerId: profile.providerId,
          // Google has already verified it.
          emailVerified: true,
          lastLoginAt: new Date(),
          preferences: { create: {} },
          subscription: { create: { tier: 'FREE' } },
          watchlists: { create: { name: 'My Watchlist', isDefault: true } },
        },
        include: { preferences: true },
      });
    }

    await this.audit(user.id, 'auth.login_google', meta);
    return this.issueTokens(user, meta);
  }

  // ── Token issuance & rotation ──────────────────────────────────

  private async issueTokens(
    user: User & { preferences?: unknown },
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      // Asserted for the same reason as in auth.module.ts — `ms` types this as
      // a template-literal union and the value arrives from env as a string.
      expiresIn: (this.config.get<string>('jwt.accessTtl') ?? '15m') as never,
    });

    const refreshToken = randomBytes(48).toString('base64url');

    await this.prisma.session.create({
      data: {
        userId: user.id,
        // Only the hash is stored. A database leak must not yield live sessions.
        refreshTokenHash: this.hashToken(refreshToken),
        userAgent: meta.userAgent?.slice(0, 300),
        ipAddress: meta.ip,
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      },
    });

    const { passwordHash: _ignored, ...safe } = user;
    return { accessToken, refreshToken, user: safe as SafeUser };
  }

  /**
   * Rotate a refresh token.
   *
   * The old token is revoked as part of the same transaction that issues the
   * new one. If a token is presented twice, the second attempt finds it revoked
   * — which is the signal that it was stolen, so every session for that user is
   * killed. This is the standard reuse-detection pattern and it is the reason
   * refresh tokens are worth having at all.
   */
  async refresh(
    refreshToken: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<AuthResult> {
    const hash = this.hashToken(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { include: { preferences: true } } },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.revokedAt) {
      // Reuse of an already-rotated token. Treat as compromise.
      this.logger.warn(`refresh token reuse detected for user ${session.userId}`);
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(session.userId, 'auth.refresh_reuse_detected', meta);
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (!session.user.isActive) {
      throw new UnauthorizedException('This account has been deactivated');
    }

    const newRefreshToken = randomBytes(48).toString('base64url');

    await this.prisma.$transaction([
      this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.session.create({
        data: {
          userId: session.userId,
          refreshTokenHash: this.hashToken(newRefreshToken),
          userAgent: meta.userAgent?.slice(0, 300),
          ipAddress: meta.ip,
          expiresAt: new Date(Date.now() + this.refreshTtlMs()),
        },
      }),
    ]);

    const payload: JwtPayload = {
      sub: session.user.id,
      email: session.user.email,
      role: session.user.role,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      // Asserted for the same reason as in auth.module.ts — `ms` types this as
      // a template-literal union and the value arrives from env as a string.
      expiresIn: (this.config.get<string>('jwt.accessTtl') ?? '15m') as never,
    });

    const { passwordHash: _ignored, ...safe } = session.user;
    return { accessToken, refreshToken: newRefreshToken, user: safe as SafeUser };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: this.hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<{ revoked: number }> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.session.updateMany({
      // Scoped by userId so one user cannot revoke another's session by id.
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new BadRequestException('Session not found');
  }

  // ── Password reset ─────────────────────────────────────────────

  /**
   * Always resolves successfully, whether or not the email exists.
   *
   * A "no account found" response turns this endpoint into a free user
   * enumeration oracle.
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    const message =
      'If an account exists for that address, a password reset link has been sent.';

    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user) return { message };

    if (user.provider === 'GOOGLE' && !user.passwordHash) {
      await this.mail.send({
        to: user.email,
        subject: 'Sign in with Google',
        text:
          `Hi ${user.name},\n\n` +
          'You requested a password reset, but this account signs in with Google. ' +
          'Use the "Continue with Google" button instead.\n',
      });
      return { message };
    }

    const token = randomBytes(32).toString('base64url');

    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        purpose: 'PASSWORD_RESET',
        // Short window — a reset link is a live credential.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const link = `${this.webUrl()}/reset-password?token=${token}`;
    await this.mail.send({
      to: user.email,
      subject: 'Reset your password',
      text:
        `Hi ${user.name},\n\n` +
        `Reset your password here (valid for one hour):\n${link}\n\n` +
        "If you didn't request this, you can ignore this email — your password is unchanged.\n",
    });

    return { message };
  }

  async resetPassword(token: string, password: string): Promise<{ message: string }> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });

    if (!record || record.purpose !== 'PASSWORD_RESET' || record.usedAt) {
      throw new BadRequestException('This reset link is invalid or has already been used');
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This reset link has expired. Request a new one.');
    }

    const passwordHash = await argon2.hash(password, this.hashOptions);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Changing a password must invalidate every existing session — otherwise
      // an attacker who already has one keeps it.
      this.prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit(record.userId, 'auth.password_reset', {});
    return { message: 'Password updated. Please sign in with your new password.' };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new BadRequestException('This account has no password set. Sign in with Google.');
    }

    const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await argon2.hash(newPassword, this.hashOptions);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit(userId, 'auth.password_changed', {});
    return { message: 'Password updated. Other devices have been signed out.' };
  }

  // ── Email verification ─────────────────────────────────────────

  private async sendVerificationEmail(userId: string, email: string, name: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');

    await this.prisma.verificationToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        purpose: 'EMAIL_VERIFY',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const link = `${this.webUrl()}/verify-email?token=${token}`;
    await this.mail.send({
      to: email,
      subject: 'Verify your email',
      text: `Hi ${name},\n\nConfirm your email address:\n${link}\n\nThe link is valid for 24 hours.\n`,
    });
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });

    if (!record || record.purpose !== 'EMAIL_VERIFY' || record.usedAt) {
      throw new BadRequestException('This verification link is invalid or has already been used');
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This verification link has expired');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: 'Email verified.' };
  }

  // ── Helpers ────────────────────────────────────────────────────

  async findById(userId: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { preferences: true, subscription: true },
    });
    if (!user) return null;
    const { passwordHash: _ignored, ...safe } = user;
    return safe as SafeUser;
  }

  /** SHA-256. Tokens are 384 bits of entropy, so no salt or stretching needed. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Constant-time compare, for the rare paths that compare raw values. */
  static safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) return false;
    return timingSafeEqual(bufferA, bufferB);
  }

  private refreshTtlMs(): number {
    const ttl = this.config.get<string>('jwt.refreshTtl') ?? '30d';
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
    return value * multiplier;
  }

  private webUrl(): string {
    return this.config.get<string[]>('corsOrigins')?.[0] ?? 'http://localhost:3000';
  }

  private async audit(
    userId: string,
    action: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          userId,
          action,
          ipAddress: meta.ip,
          userAgent: meta.userAgent?.slice(0, 300),
        },
      })
      .catch(() => undefined); // auditing must never block the request
  }
}

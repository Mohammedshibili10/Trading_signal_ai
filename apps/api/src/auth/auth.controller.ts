import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';

import { CurrentUser, Public } from '../common/decorators';
import { AuthService, type AuthResult } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto';

const REFRESH_COOKIE = 'tip_refresh';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  // ── Registration & login ───────────────────────────────────────

  @Public()
  // Registration is expensive (Argon2) and a prime target for abuse.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create an account' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.register(dto.email, dto.name, dto.password, this.meta(request));
    return this.respondWithTokens(result, response);
  }

  @Public()
  // Deliberately tight: this is the endpoint credential stuffing hits.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password, this.meta(request));
    return this.respondWithTokens(result, response);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new access token' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { refreshToken?: string },
  ) {
    // Cookie first (browser), body second (mobile / native clients).
    const token = (request.cookies?.[REFRESH_COOKIE] as string | undefined) ?? body?.refreshToken;
    if (!token) throw new UnauthorizedException('No refresh token supplied');

    const result = await this.auth.refresh(token, this.meta(request));
    return this.respondWithTokens(result, response);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out on this device' })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = request.cookies?.[REFRESH_COOKIE] as string | undefined;
    await this.auth.logout(token);
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { message: 'Signed out' };
  }

  // ── Google OAuth ───────────────────────────────────────────────

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Start the Google sign-in flow' })
  googleAuth(): void {
    // Passport handles the redirect. This body never executes.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() request: Request, @Res() response: Response): Promise<void> {
    const profile = request.user as {
      email: string;
      name: string;
      providerId: string;
      avatarUrl?: string;
    };

    const result = await this.auth.validateGoogleUser(profile, this.meta(request));
    response.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions());

    // The access token goes back via the URL fragment rather than a query
    // string — fragments are not sent to the server and stay out of access
    // logs, proxy logs and Referer headers. The client reads it and clears it.
    const webUrl = this.config.get<string[]>('corsOrigins')?.[0] ?? 'http://localhost:3000';
    response.redirect(`${webUrl}/auth/callback#access_token=${result.accessToken}`);
  }

  // ── Password ───────────────────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change your password' })
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  // ── Profile & sessions ─────────────────────────────────────────

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  async me(@CurrentUser('id') userId: string) {
    const user = await this.auth.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'Active sessions on all devices' })
  sessions(@CurrentUser('id') userId: string) {
    return this.auth.listSessions(userId);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @ApiOperation({ summary: 'Revoke one session' })
  async revokeSession(@CurrentUser('id') userId: string, @Param('id') sessionId: string) {
    await this.auth.revokeSession(userId, sessionId);
    return { message: 'Session revoked' };
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out everywhere' })
  async logoutAll(
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.logoutAll(userId);
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { message: `Signed out of ${result.revoked} session(s)` };
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Refresh token → httpOnly cookie. Access token → response body.
   *
   * The refresh token is the long-lived credential, so it must be unreachable
   * from JavaScript; an XSS should not be able to mint sessions indefinitely.
   * The access token lives in memory in Redux and dies with the tab.
   */
  private respondWithTokens(result: AuthResult, response: Response) {
    response.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions());
    return { user: result.user, accessToken: result.accessToken };
  }

  private cookieOptions(): CookieOptions {
    const secure = this.config.get<boolean>('cookie.secure') ?? false;
    return {
      httpOnly: true,
      secure,
      // 'lax' still sends the cookie on the Google OAuth top-level redirect,
      // while blocking it on cross-site subrequests. 'strict' would break the
      // callback; 'none' would require secure and weaken CSRF protection.
      sameSite: 'lax',
      path: '/',
      domain: this.config.get<string>('cookie.domain') || undefined,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    };
  }

  private meta(request: Request): { ip?: string; userAgent?: string } {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}

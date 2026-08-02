import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';

import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../common/decorators';
import type { JwtPayload } from './dto';

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(JwtStrategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret')!,
    });
  }

  /**
   * Re-checks the user on every request.
   *
   * The token alone would be enough and would avoid a query, but then
   * deactivating an account or demoting a role wouldn't take effect until the
   * access token expired. Fifteen minutes of stale authorisation is not
   * acceptable for an admin revocation, and the lookup is a primary-key hit.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user) throw new UnauthorizedException('Account no longer exists');
    if (!user.isActive) throw new UnauthorizedException('This account has been deactivated');

    return { id: user.id, email: user.email, role: user.role };
  }
}

/**
 * Google OAuth.
 *
 * Only registered when credentials are configured — see AuthModule. Passport
 * throws at construction time if clientID is missing, which would take the
 * whole API down just because someone hasn't set up OAuth.
 */
@Injectable()
export class GoogleOAuthStrategy extends PassportStrategy(GoogleStrategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.get<string>('google.clientId')!,
      clientSecret: config.get<string>('google.clientSecret')!,
      callbackURL: config.get<string>('google.callbackUrl')!,
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): { email: string; name: string; providerId: string; avatarUrl?: string } {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      throw new UnauthorizedException('Google account did not return an email address');
    }

    return {
      email,
      name: profile.displayName || email.split('@')[0],
      providerId: profile.id,
      avatarUrl: profile.photos?.[0]?.value,
    };
  }
}

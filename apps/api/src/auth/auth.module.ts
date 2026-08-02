import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { GoogleOAuthStrategy, JwtAccessStrategy } from './strategies';

/** What `jsonwebtoken` accepts for `expiresIn` — a duration string or seconds. */
type ExpiresIn = Parameters<typeof JwtModule.register>[0]['signOptions'] extends
  | { expiresIn?: infer T }
  | undefined
  ? T
  : never;

/**
 * The Google strategy is only provided when credentials exist.
 *
 * passport-google-oauth20 throws `OAuth2Strategy requires a clientID option`
 * at construction, so unconditionally registering it would take the entire API
 * down for anyone who hasn't set up OAuth. The `/auth/google` routes then
 * return 401 rather than 500, and the frontend hides the button.
 */
const googleProviders: Provider[] = (() => {
  const enabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (!enabled) {
    new Logger('AuthModule').log('Google OAuth disabled — no credentials configured');
    return [];
  }
  return [GoogleOAuthStrategy];
})();

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        // `ms` types expiresIn as a template-literal union ("15m", "7d", …).
        // The value comes from env as a plain string, so it is asserted here
        // rather than duplicating that union in our config types.
        signOptions: { expiresIn: (config.get<string>('jwt.accessTtl') ?? '15m') as ExpiresIn },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, MailService, JwtAccessStrategy, ...googleProviders],
  exports: [AuthService, MailService],
})
export class AuthModule {}

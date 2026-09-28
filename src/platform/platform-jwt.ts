import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { PLATFORM_AUDIENCE } from './platform-policy';

/**
 * A JwtService of its own: platform tokens are signed with
 * PLATFORM_JWT_SECRET and carry aud=platform, so the tenant guard can never
 * accept one, and vice versa (ADR 0011).
 */
export const PLATFORM_JWT = Symbol('PLATFORM_JWT');

export const platformJwtProvider = {
  provide: PLATFORM_JWT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new JwtService({
      secret: config.get('PLATFORM_JWT_SECRET', { infer: true }),
      signOptions: { algorithm: 'HS256', audience: PLATFORM_AUDIENCE },
      verifyOptions: { algorithms: ['HS256'], audience: PLATFORM_AUDIENCE },
    }),
};

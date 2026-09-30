import { applyDecorators, Header } from '@nestjs/common';
import { ApiBearerAuth, ApiExtension, ApiTags } from '@nestjs/swagger';

/**
 * Every controller of API v0 (ADR 0025): its Swagger area, the draft
 * marker, and bearer auth for tenant routes. Platform routes get their
 * bearer from `@PlatformAuth`; public ones have none.
 */
export function ApiArea(
  tag: string,
  auth: 'tenant' | 'platform' | 'public' = 'tenant',
) {
  return applyDecorators(
    ApiTags(tag),
    ApiExtension('x-stability', 'draft'),
    ...(auth === 'tenant' ? [ApiBearerAuth()] : []),
  );
}

/**
 * A response that carries a secret shown once (an access code, an invite
 * or link token, session tokens): never cached anywhere on the way.
 */
export function NoStore() {
  return applyDecorators(
    Header('Cache-Control', 'no-store'),
    ApiExtension('x-no-store', true),
  );
}

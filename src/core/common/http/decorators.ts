import {
  applyDecorators,
  createParamDecorator,
  Header,
  Injectable,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
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
 * A header the server reads off the request without declaring it in the
 * OpenAPI document, as `@Headers(name)` would (as a required parameter).
 * For what a client sends anyway (`user-agent`, `accept-language`), or what
 * `@ApiHeader` already documents.
 */
export const RequestHeader = createParamDecorator(
  (name: string, context: ExecutionContext): string | undefined => {
    const value = context.switchToHttp().getRequest<Request>().headers[
      name.toLowerCase()
    ];
    return Array.isArray(value) ? value[0] : value;
  },
);

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

/** The three headers of a public page that carries a secret (ADR 0030). */
export const PUBLIC_PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
} as const;

@Injectable()
export class PublicPageHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Before the handler: a 404 or a 429 carries them too, so every answer
    // looks the same and none is cached, indexed or leaked as a referrer.
    const res = context.switchToHttp().getResponse<Response>();
    for (const [name, value] of Object.entries(PUBLIC_PAGE_HEADERS))
      res.setHeader(name, value);
    return next.handle();
  }
}

/**
 * A public endpoint that takes or returns a link's secret (the visitor
 * page, ADR 0030): no-store, no referrer, not indexed, on every response.
 */
export function PublicPageHeaders() {
  return applyDecorators(
    UseInterceptors(PublicPageHeadersInterceptor),
    ApiExtension('x-no-store', true),
  );
}

import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { IDEMPOTENCY_HEADER, IDEMPOTENT_SECRET } from './idempotency-key';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/** Documents the optional `Idempotency-Key` header. */
export function IdempotencyHeader() {
  return ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: false,
    description:
      'A client-generated id (8–128 of A-Z a-z 0-9 . _ : -). A retry with the same key replays the first response for 24 h; another request with it is 409 IDEMPOTENCY_CONFLICT.',
  });
}

/**
 * The route honours `Idempotency-Key` (ADR 0028). Its service must call
 * `IdempotencyService.claim(tx, ref)` first in its transaction.
 *
 * `secret`: the response carries a secret shown once (ADR 0030). Its body is
 * never stored; every replay is rendered from the resource ref, so the
 * renderer must issue a fresh secret (or none), never return the old one.
 */
export function Idempotent(options: { secret?: boolean } = {}) {
  return applyDecorators(
    IdempotencyHeader(),
    SetMetadata(IDEMPOTENT_SECRET, options.secret === true),
    UseInterceptors(IdempotencyInterceptor),
  );
}

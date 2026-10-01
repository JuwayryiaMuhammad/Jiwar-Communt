import { createHash } from 'node:crypto';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { stableJson } from '../common/http/stable-json';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** How long a key is remembered (and its response replayed). */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The header's value, or undefined when absent. A client-generated UUID is
 * the expected value; anything outside 8–128 safe characters is rejected.
 */
export function parseIdempotencyKey(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && KEY.test(raw)) return raw;
  throw appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid Idempotency-Key',
    {
      fields: [
        {
          field: IDEMPOTENCY_HEADER,
          code: FieldErrorCode.INVALID_FORMAT,
          params: { min: 8, max: 128 },
        },
      ],
    },
  );
}

/** What makes two requests "the same": route, params and body. */
export function requestHash(
  method: string,
  route: string,
  params: unknown,
  body: unknown,
): string {
  return createHash('sha256')
    .update(stableJson([method, route, params ?? {}, body ?? {}]))
    .digest('hex');
}

/**
 * Thrown by a claim that lost to a committed duplicate: the transaction
 * rolls back and the interceptor replays the winner's response. Never
 * reaches a client.
 */
export class IdempotencyReplaySignal extends Error {
  constructor() {
    super('Idempotency-Key already used; replaying');
    this.name = 'IdempotencyReplaySignal';
  }
}

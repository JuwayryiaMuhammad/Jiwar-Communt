import { ParseUUIDPipe } from '@nestjs/common';
import { appError, ErrorCode, FieldErrorCode } from '../errors';

/** `@Param('id', parseId())` — a UUID path param with the standard error body. */
export function parseId(field = 'id'): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `${field} must be a UUID`,
        {
          fields: [{ field, code: FieldErrorCode.INVALID_UUID }],
        },
      ),
  });
}

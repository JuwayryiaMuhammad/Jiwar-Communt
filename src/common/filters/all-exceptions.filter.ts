import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { ErrorCode } from '../errors';

/** A `details` bag written by our own services — not an Error, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

/** Fallback `code` when a service threw without one. */
const DEFAULT_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/**
 * Uniform error envelope across the API (same contract as Jiwar-Hub-backend):
 * `{ statusCode, message, error, code, details, requestId, timestamp, path }`.
 *
 * `code` is the machine-readable discriminator. Services set it by throwing
 * the object form, `new ConflictException({ message, code, details })`;
 * otherwise it is derived from the status. `code` and `details` are forwarded
 * key by key, never by spreading, so fields of a caught third-party error
 * cannot reach the wire.
 *
 * Unique-constraint violations become a neutral 409 that names no column and
 * no existing row (ADR 0006). Anything unexpected is a 500 with a generic
 * message, logged in full server-side.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error: string | undefined;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'string') {
        message = r;
      } else if (r && typeof r === 'object') {
        const obj = r as {
          message?: string | string[];
          error?: string;
          code?: unknown;
          details?: unknown;
        };
        message = obj.message ?? exception.message;
        error = obj.error;
        if (typeof obj.code === 'string') code = obj.code;
        if (isPlainObject(obj.details)) details = obj.details;
      } else {
        message = exception.message;
      }
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002'
    ) {
      status = HttpStatus.CONFLICT;
      message = 'The resource conflicts with an existing one';
      code = ErrorCode.CONFLICT;
    } else if (exception instanceof Error) {
      // Express body-parser errors carry http-errors semantics (`status`,
      // `expose`); honour them instead of turning a bad request into a 500.
      const httpish = exception as Error & {
        status?: unknown;
        statusCode?: unknown;
        expose?: unknown;
      };
      const claimed = httpish.status ?? httpish.statusCode;
      if (
        typeof claimed === 'number' &&
        Number.isInteger(claimed) &&
        claimed >= 400 &&
        claimed <= 599
      ) {
        status = claimed;
        if (httpish.expose === true && claimed < 500) {
          message = exception.message;
        }
      }
      this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error(`Non-error thrown: ${String(exception)}`);
    }

    code ??= DEFAULT_CODE[status];

    res.status(status).json({
      statusCode: status,
      message,
      ...(error ? { error } : {}),
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
      requestId: req.id,
      timestamp: new Date().toISOString(),
      path: req.originalUrl ?? req.url,
    });
  }
}

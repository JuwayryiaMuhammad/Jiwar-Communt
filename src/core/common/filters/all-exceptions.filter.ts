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
import { UNIQUE_CONSTRAINT_FIELDS } from '../db-constraints';
import {
  ErrorCode,
  FieldErrorCode,
  type ErrorParams,
  type FieldError,
} from '../errors';

/** A `details`/`params` bag written by our own code — not an Error, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

function isFieldErrorList(value: unknown): value is FieldError[] {
  return (
    Array.isArray(value) &&
    value.every(
      (f) =>
        isPlainObject(f) &&
        typeof f.field === 'string' &&
        typeof f.code === 'string',
    )
  );
}

/** Fallback `code` for errors thrown without one (framework, body parser…). */
const STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  429: ErrorCode.RATE_LIMITED,
  503: ErrorCode.NOT_READY,
};

interface Envelope {
  status: number;
  message: string | string[];
  error?: string;
  code: string;
  params?: ErrorParams;
  fields?: FieldError[];
  details?: Record<string, unknown>;
}

const INTERNAL: Envelope = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  message: 'Internal server error',
  code: ErrorCode.INTERNAL_ERROR,
};

/**
 * Uniform error envelope (ADR 0013):
 * `{ statusCode, message, error, code, params, fields, details, requestId, timestamp, path }`.
 *
 * - `code` is always present; `message` is English for developers only.
 * - `code`/`params`/`fields`/`details` are forwarded key by key after a shape
 *   check, never by spreading, so fields of a caught third-party error cannot
 *   reach the wire.
 * - Database errors are mapped to stable codes; their text (table, column and
 *   constraint names) is logged server-side and never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    const e = this.toEnvelope(exception);

    res.status(e.status).json({
      statusCode: e.status,
      message: e.message,
      ...(e.error ? { error: e.error } : {}),
      code: e.code,
      ...(e.params ? { params: e.params } : {}),
      ...(e.fields ? { fields: e.fields } : {}),
      ...(e.details ? { details: e.details } : {}),
      requestId: req.id,
      timestamp: new Date().toISOString(),
      path: req.originalUrl ?? req.url,
    });
  }

  private toEnvelope(exception: unknown): Envelope {
    if (exception instanceof HttpException) return this.fromHttp(exception);
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }
    if (exception instanceof Error) {
      const fromHttpErrors = this.fromHttpErrorsContract(exception);
      if (fromHttpErrors) return fromHttpErrors;
      this.logger.error(exception.message, exception.stack);
      return INTERNAL;
    }
    this.logger.error(`Non-error thrown: ${String(exception)}`);
    return INTERNAL;
  }

  private fromHttp(exception: HttpException): Envelope {
    const status = exception.getStatus();
    const r = exception.getResponse();
    const e: Envelope = {
      status,
      message: exception.message,
      code:
        STATUS_CODE[status] ??
        (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.REQUEST_FAILED),
    };
    if (typeof r === 'string') {
      e.message = r;
    } else if (isPlainObject(r)) {
      if (typeof r.message === 'string' || Array.isArray(r.message)) {
        e.message = r.message as string | string[];
      }
      if (typeof r.error === 'string') e.error = r.error;
      if (typeof r.code === 'string') e.code = r.code;
      if (isPlainObject(r.params)) e.params = r.params as ErrorParams;
      if (isFieldErrorList(r.fields)) e.fields = r.fields;
      if (isPlainObject(r.details)) e.details = r.details;
    }
    if (status >= 500)
      this.logger.error(`${status} ${e.code}: ${String(e.message)}`);
    return e;
  }

  private fromPrisma(
    exception: Prisma.PrismaClientKnownRequestError,
  ): Envelope {
    switch (exception.code) {
      case 'P2002': {
        const fields = duplicateFields(exception);
        return {
          status: HttpStatus.CONFLICT,
          message: 'The resource conflicts with an existing one',
          code: ErrorCode.DUPLICATE_RESOURCE,
          ...(fields ? { fields } : {}),
        };
      }
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          message: 'A related resource does not exist',
          code: ErrorCode.RELATED_RESOURCE_MISSING,
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'Resource not found',
          code: ErrorCode.NOT_FOUND,
        };
      default:
        this.logger.error(
          `Prisma ${exception.code}: ${exception.message}`,
          exception.stack,
        );
        return INTERNAL;
    }
  }

  /**
   * Express's body parser throws plain Errors with http-errors semantics
   * (`status`, `expose`), e.g. an oversized body. Honour them instead of
   * turning the caller's bad request into a 500.
   */
  private fromHttpErrorsContract(exception: Error): Envelope | null {
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
      claimed < 500 &&
      httpish.expose === true
    ) {
      return {
        status: claimed,
        message: exception.message,
        code: STATUS_CODE[claimed] ?? ErrorCode.REQUEST_FAILED,
      };
    }
    return null;
  }
}

/** Fields behind a unique violation, or undefined to stay neutral. */
function duplicateFields(
  exception: Prisma.PrismaClientKnownRequestError,
): FieldError[] | undefined {
  const meta = exception.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
      }
    | undefined;
  const index =
    meta?.driverAdapterError?.cause?.constraint?.index ?? meta?.target;
  if (typeof index !== 'string' || index.endsWith('_pkey')) return undefined;
  const fields = UNIQUE_CONSTRAINT_FIELDS[index];
  return fields?.map((field) => ({
    field,
    code: FieldErrorCode.DUPLICATE_VALUE,
  }));
}

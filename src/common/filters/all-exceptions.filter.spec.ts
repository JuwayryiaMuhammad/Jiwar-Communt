import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { appError, ErrorCode } from '../errors';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const res = {
    statusCode: 0,
    body: undefined as unknown as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ id: 'req-1', originalUrl: '/api/v1/x' }),
    }),
  } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  // Keep expected error logs out of the test output.
  (filter as unknown as { logger: { error: () => void } }).logger = {
    error: () => undefined,
  };
  filter.catch(exception, host);
  return res;
}

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(
    'Invalid `prisma.account.create()` invocation: relation "accounts" constraint "accounts_pkey"',
    { code, clientVersion: 'test', meta },
  );
}

function adapterUnique(index: string) {
  return {
    driverAdapterError: {
      cause: {
        kind: 'UniqueConstraintViolation',
        constraint: { index },
        table: 'accounts',
      },
    },
  };
}

describe('AllExceptionsFilter', () => {
  it('forwards code, params and fields from AppException', () => {
    const res = run(
      appError.conflict(ErrorCode.CONFLICT, 'dev message', {
        params: { limit: 3 },
        fields: [{ field: 'email', code: 'DUPLICATE_VALUE' }],
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'dev message',
      params: { limit: 3 },
      fields: [{ field: 'email', code: 'DUPLICATE_VALUE' }],
      requestId: 'req-1',
      path: '/api/v1/x',
    });
  });

  it('gives framework exceptions a code from their status', () => {
    const res = run(new NotFoundException('Cannot GET /nope'));
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('turns unknown errors into a generic 500 INTERNAL_ERROR', () => {
    const res = run(new Error('relation "accounts" does not exist'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toContain('accounts');
  });

  it('maps a unique violation to DUPLICATE_RESOURCE with the API field', () => {
    const res = run(
      prismaError('P2002', adapterUnique('accounts_tenant_id_type_email_key')),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      fields: [{ field: 'email', code: 'DUPLICATE_VALUE' }],
    });
  });

  it('keeps a primary-key collision neutral', () => {
    const res = run(prismaError('P2002', adapterUnique('accounts_pkey')));
    expect(res.body).toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    expect(res.body.fields).toBeUndefined();
  });

  it('maps P2003 and P2025', () => {
    expect(run(prismaError('P2003')).body).toMatchObject({
      statusCode: 409,
      code: 'RELATED_RESOURCE_MISSING',
    });
    expect(run(prismaError('P2025')).body).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('never leaks database text for other Prisma errors', () => {
    const res = run(
      prismaError('P2010', {
        driverAdapterError: { cause: { table: 'accounts' } },
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('accounts');
    expect(text).not.toContain('prisma');
  });

  it('drops malformed fields/params instead of forwarding them', () => {
    const res = run(
      appError.badRequest(ErrorCode.VALIDATION_FAILED, 'x', {
        fields: 'oops' as never,
        params: ['a'] as never,
      }),
    );
    expect(res.body.fields).toBeUndefined();
    expect(res.body.params).toBeUndefined();
  });
});

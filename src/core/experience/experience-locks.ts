import type { ExperienceCase, ExperienceCompensation } from '@prisma/client';
import { appError, ErrorCode } from '../common/errors';
import type { TenantTxClient } from '../database/tenant-tx.service';

// The locks of experience and recovery (ADR 0082), always in this order:
//
// 1. the caller's account row, shared (an erasure waits, or wins first);
// 2. the case's row (FOR UPDATE to close or assign it, FOR SHARE to propose
//    or decide one of its compensations: a close waits for them);
// 3. the compensation's row, FOR UPDATE: two decisions meet here;
// 4. finance's own locks, through the compensation credits port, then the
//    board's authorization's row (ADR 0073).
//
// A signal takes no account: it inserts its row under its key, then the
// counter's row, then the case under the one-open-per-unit index.

export async function lockSelf(
  tx: TenantTxClient,
  accountId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM accounts
     WHERE id = ${accountId}::uuid FOR SHARE`;
  if (rows[0]?.status !== 'active')
    throw appError.unauthorized(
      ErrorCode.UNAUTHENTICATED,
      'Authentication required',
    );
}

export const caseNotFound = () =>
  appError.notFound(
    ErrorCode.EXPERIENCE_CASE_NOT_FOUND,
    'Experience case not found',
  );

export const compensationNotFound = () =>
  appError.notFound(ErrorCode.COMPENSATION_NOT_FOUND, 'Compensation not found');

/** The case under its lock; EXPERIENCE_CASE_CLOSED unless open. */
export async function lockOpenCase(
  tx: TenantTxClient,
  id: string,
  mode: 'update' | 'share',
): Promise<ExperienceCase> {
  if (mode === 'update')
    await tx.$queryRaw`SELECT id FROM experience_cases WHERE id = ${id}::uuid FOR UPDATE`;
  else
    await tx.$queryRaw`SELECT id FROM experience_cases WHERE id = ${id}::uuid FOR SHARE`;
  const found = await tx.experienceCase.findUnique({ where: { id } });
  if (!found) throw caseNotFound();
  if (found.status !== 'open')
    throw appError.conflict(
      ErrorCode.EXPERIENCE_CASE_CLOSED,
      'This case is closed',
    );
  return found;
}

/** The compensation under its lock; COMPENSATION_DECIDED unless proposed. */
export async function lockProposed(
  tx: TenantTxClient,
  id: string,
): Promise<ExperienceCompensation> {
  await tx.$queryRaw`SELECT id FROM experience_compensations WHERE id = ${id}::uuid FOR UPDATE`;
  const found = await tx.experienceCompensation.findUnique({ where: { id } });
  if (!found) throw compensationNotFound();
  if (found.status !== 'proposed')
    throw appError.conflict(
      ErrorCode.COMPENSATION_DECIDED,
      'This compensation is decided already',
      { params: { status: found.status } },
    );
  return found;
}

/** The database's clock, to the millisecond. */
export async function clock(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}

import type { Prisma } from '@prisma/client';
import { normalizeEmail, normalizePhone } from '../auth/identifier';

/**
 * Which accounts a typed text finds (ADR 0072): part of the name, any case,
 * or exactly the phone or the email. An erased account has no name left and
 * is never found. The staff's search, and the account and resident lists'
 * `q`, share it.
 */
export function accountTextFilter(raw: string): Prisma.AccountWhereInput {
  const text = raw.trim();
  const email = normalizeEmail(text);
  const phone = normalizePhone(text);
  return {
    status: { not: 'erased' },
    OR: [
      { fullName: { contains: text, mode: 'insensitive' } },
      ...(email ? [{ email }] : []),
      ...(phone ? [{ phone }] : []),
    ],
  };
}

import type {
  Account,
  AccountStatus,
  AccountType,
  IdDocumentType,
  Locale,
} from '@prisma/client';

/**
 * An account as the services return it: every field, unmasked. Responses
 * never carry it as is; they go through the views in `views/` (ADR 0025).
 */
export class AccountRecord {
  id: string;
  type: AccountType;
  /** Personal fields are null on an erased account (a deleted user, ADR 0023). */
  fullName: string | null;
  idDocumentType: IdDocumentType | null;
  idDocumentNumber: string | null;
  nationality: string | null;
  /** `YYYY-MM-DD`; null only on legacy accounts. */
  birthDate: string | null;
  /** Null only while frozen: the number went to someone else (ADR 0023). */
  phone: string | null;
  email: string | null;
  status: AccountStatus;
  preferredLocale: Locale;
  createdAt: Date;

  static from(account: Account): AccountRecord {
    return {
      id: account.id,
      type: account.type,
      fullName: account.fullName,
      idDocumentType: account.idDocumentType,
      idDocumentNumber: account.idDocumentNumber,
      nationality: account.nationality,
      birthDate: isoDate(account.birthDate),
      phone: account.phone,
      email: account.email,
      status: account.status,
      preferredLocale: account.preferredLocale,
      createdAt: account.createdAt,
    };
  }
}

export function isoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

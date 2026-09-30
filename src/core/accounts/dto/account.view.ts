import type {
  Account,
  AccountStatus,
  AccountType,
  IdDocumentType,
} from '@prisma/client';

export class AccountView {
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
  createdAt: Date;

  static from(account: Account): AccountView {
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
      createdAt: account.createdAt,
    };
  }
}

export function isoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

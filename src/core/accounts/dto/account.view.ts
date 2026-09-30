import type {
  Account,
  AccountStatus,
  AccountType,
  IdDocumentType,
} from '@prisma/client';

export class AccountView {
  id: string;
  type: AccountType;
  fullName: string;
  idDocumentType: IdDocumentType;
  idDocumentNumber: string;
  nationality: string;
  /** `YYYY-MM-DD`; null only on legacy accounts. */
  birthDate: string | null;
  phone: string;
  email: string;
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

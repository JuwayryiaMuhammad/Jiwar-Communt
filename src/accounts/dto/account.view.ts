import type { Account, AccountStatus, AccountType } from '@prisma/client';

export class AccountView {
  id: string;
  type: AccountType;
  fullName: string;
  nationalId: string;
  phone: string;
  email: string;
  status: AccountStatus;
  createdAt: Date;

  static from(account: Account): AccountView {
    return {
      id: account.id,
      type: account.type,
      fullName: account.fullName,
      nationalId: account.nationalId,
      phone: account.phone,
      email: account.email,
      status: account.status,
      createdAt: account.createdAt,
    };
  }
}

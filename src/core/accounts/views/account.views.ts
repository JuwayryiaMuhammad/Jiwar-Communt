import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, AccountType, IdDocumentType } from '@prisma/client';
import {
  erased,
  isErased,
  maskDocument,
  type ErasedAccount,
} from '../../common/http/personal';
import type { AccountRecord } from '../account-record';

/**
 * An account in a manager's list: contact details, never the document or
 * the birth date. An erased account is `{ id, erased: true }`.
 */
export class AccountListItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: AccountType, enumName: 'AccountType', required: false })
  type?: AccountType;
  @ApiProperty({ type: String, required: false })
  fullName?: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    description: 'Null while frozen.',
  })
  phone?: string | null;
  @ApiProperty({ type: String, required: false })
  email?: string | null;
  @ApiProperty({
    enum: AccountStatus,
    enumName: 'AccountStatus',
    required: false,
  })
  status?: AccountStatus;
  @ApiProperty({ type: String, format: 'date-time', required: false })
  createdAt?: Date;
  @ApiProperty({
    type: Boolean,
    enum: [true],
    required: false,
    description: 'Only on an erased account, which has no other field.',
  })
  erased?: true;

  static from(a: AccountRecord): AccountListItemView | ErasedAccount {
    if (isErased(a)) return erased(a.id);
    return {
      id: a.id,
      type: a.type,
      fullName: a.fullName,
      phone: a.phone,
      email: a.email,
      status: a.status,
      createdAt: a.createdAt,
    };
  }
}

/** One account, for a manager: the document masked to its last four. */
export class AccountDetailView extends AccountListItemView {
  @ApiProperty({
    enum: IdDocumentType,
    enumName: 'IdDocumentType',
    nullable: true,
    required: false,
  })
  idDocumentType?: IdDocumentType | null;
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    example: '••••1234',
  })
  idDocumentNumberMasked?: string | null;
  @ApiProperty({ type: String, nullable: true, required: false })
  nationality?: string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    required: false,
  })
  birthDate?: string | null;

  static fromRecord(a: AccountRecord): AccountDetailView | ErasedAccount {
    if (isErased(a)) return erased(a.id);
    return {
      id: a.id,
      type: a.type,
      fullName: a.fullName,
      idDocumentType: a.idDocumentType,
      idDocumentNumberMasked: maskDocument(a.idDocumentNumber),
      nationality: a.nationality,
      birthDate: a.birthDate,
      phone: a.phone,
      email: a.email,
      status: a.status,
      createdAt: a.createdAt,
    };
  }
}

import { ApiProperty } from '@nestjs/swagger';

/** `••••1234`: the last four characters of an identity document, never more. */
export function maskDocument(number: string | null): string | null {
  if (!number) return null;
  return `••••${number.slice(-4)}`;
}

/** Account statuses whose rows no longer carry personal data (ADR 0023). */
export function isErased(account: { status: string }): boolean {
  return account.status === 'erased';
}

export interface ErasedAccount {
  id: string;
  erased: true;
}

/** How every view renders an erased account: its id, and nothing personal. */
export function erased(id: string): ErasedAccount {
  return { id, erased: true };
}

/** Another account named in a view: its id and name, or the erased shape. */
export class AccountRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'Absent when erased.',
  })
  fullName?: string | null;

  @ApiProperty({
    type: Boolean,
    required: false,
    enum: [true],
    description: 'Present (true) only on an erased account.',
  })
  erased?: true;
}

export function accountRef(account: {
  id: string;
  fullName: string | null;
  status: string;
}): AccountRefView {
  return isErased(account)
    ? erased(account.id)
    : { id: account.id, fullName: account.fullName };
}

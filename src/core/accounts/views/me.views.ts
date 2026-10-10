import { ApiProperty } from '@nestjs/swagger';
import {
  AccountStatus,
  AccountType,
  IdDocumentType,
  Locale,
} from '@prisma/client';
import { maskDocument } from '../../common/http/personal';
import type { MySession } from '../account-self.service';
import type { DeletionRequestView } from '../account-deletion.service';
import type { AccountRecord } from '../account-record';
import type { RoleWithPermissions } from '../../access/roles.service';

/** The holder's role (ADR 0010). */
export class MyRoleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'System roles are translated by key.',
  })
  key: string;
  @ApiProperty({ type: String, nullable: true })
  name: string | null;
}

/**
 * The holder's own account. The document is masked and the birth date left
 * out: the apps never need either back (PII decision, ADR 0025).
 */
export class MeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: AccountType, enumName: 'AccountType' })
  type: AccountType;
  @ApiProperty({ enum: AccountStatus, enumName: 'AccountStatus' })
  status: AccountStatus;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
  @ApiProperty({ type: String, nullable: true })
  email: string | null;
  @ApiProperty({ enum: Locale, enumName: 'Locale' })
  preferredLocale: Locale;
  @ApiProperty({
    enum: IdDocumentType,
    enumName: 'IdDocumentType',
    nullable: true,
  })
  idDocumentType: IdDocumentType | null;
  @ApiProperty({ type: String, nullable: true, example: '••••1234' })
  idDocumentNumberMasked: string | null;
  @ApiProperty({ type: String, nullable: true })
  nationality: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "A short-lived presigned URL of the holder's own photo (ADR 0031), or null. Shown only here and to the guard on a valid scan.",
  })
  photoUrl: string | null;
  @ApiProperty({ type: MyRoleView })
  role: MyRoleView;
  @ApiProperty({
    type: [String],
    description:
      "What the role allows now (ADR 0010), sorted: what the API will check on the holder's next request. For showing or hiding an action; every route still decides for itself.",
  })
  permissions: string[];

  static from(
    a: AccountRecord,
    photoUrl: string | null,
    role: RoleWithPermissions,
  ): MeView {
    return {
      ...MeView.profile(a, photoUrl),
      role: { id: role.id, key: role.key, name: role.name },
      permissions: [...role.permissions].sort(),
    };
  }

  /** The person's own fields, without the role: what a data export carries. */
  static profile(
    a: AccountRecord,
    photoUrl: string | null,
  ): Omit<MeView, 'role' | 'permissions'> {
    return {
      id: a.id,
      type: a.type,
      status: a.status,
      fullName: a.fullName,
      phone: a.phone,
      email: a.email,
      preferredLocale: a.preferredLocale,
      idDocumentType: a.idDocumentType,
      idDocumentNumberMasked: maskDocument(a.idDocumentNumber),
      nationality: a.nationality,
      photoUrl,
    };
  }
}

export class LocaleView {
  @ApiProperty({ enum: Locale, enumName: 'Locale' })
  preferredLocale: Locale;
}

export class SessionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastUsedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;
  @ApiProperty({ type: Boolean, description: 'The session of this request.' })
  isCurrent: boolean;

  static from(s: MySession): SessionView {
    return {
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      userAgent: s.userAgent,
      isCurrent: s.isCurrent,
    };
  }
}

export class RevokedView {
  @ApiProperty({ type: Number })
  revoked: number;
}

export class DeletionRequestResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ['pending', 'cancelled', 'completed', 'queued', 'closed'],
    enumName: 'DeletionRequestStatus',
  })
  status: DeletionRequestView['status'];
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Undo is possible until then; the account is erased after it, unless something blocks it (then `queued`).',
  })
  effectiveAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'Filed by the management for the account (ADR 0036).',
  })
  assisted: boolean;
  @ApiProperty({
    type: [String],
    description: 'Queued: what blocks the erasure.',
  })
  blockers: string[];

  static from(r: DeletionRequestView): DeletionRequestResponse {
    return {
      id: r.id,
      status: r.status,
      requestedAt: r.requestedAt,
      effectiveAt: r.effectiveAt,
      assisted: r.assisted,
      blockers: [...r.blockers],
    };
  }
}

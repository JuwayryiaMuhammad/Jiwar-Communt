import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, TenantStatus } from '@prisma/client';
import { erased, isErased } from '../../common/http/personal';
import type {
  PasswordChangeToken,
  PlatformTokens,
} from '../platform-session.service';
import type {
  ManagerSummary,
  TenantDetails,
  TenantSummary,
} from '../tenants.service';

export class TenantView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  status: TenantStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(t: TenantSummary): TenantView {
    return { id: t.id, name: t.name, status: t.status, createdAt: t.createdAt };
  }
}

/** Managers are the platform's customers: contact details are visible (ADR 0011). */
export class ManagerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, required: false })
  fullName?: string | null;
  @ApiProperty({ type: String, required: false, nullable: true })
  email?: string | null;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description: 'Null while frozen.',
  })
  phone?: string | null;
  @ApiProperty({
    enum: AccountStatus,
    enumName: 'AccountStatus',
    required: false,
  })
  status?: AccountStatus;
  @ApiProperty({
    type: Boolean,
    required: false,
    enum: [true],
    description: 'Only on an erased account, which has no other field.',
  })
  erased?: true;

  static from(m: ManagerSummary): ManagerView {
    if (isErased(m)) return erased(m.id);
    return {
      id: m.id,
      fullName: m.fullName,
      email: m.email,
      phone: m.phone,
      status: m.status,
    };
  }
}

export class TenantDetailView extends TenantView {
  @ApiProperty({ type: [ManagerView] })
  managers: ManagerView[];

  static fromDetails(t: TenantDetails): TenantDetailView {
    return {
      ...TenantView.from(t),
      managers: t.managers.map((m) => ManagerView.from(m)),
    };
  }
}

export class PlatformTokensView {
  @ApiProperty({
    enum: ['full', 'password_change'],
    description:
      '`password_change`: only POST /platform/auth/change-password accepts this token.',
  })
  scope: 'full' | 'password_change';
  @ApiProperty({ type: String })
  accessToken: string;
  @ApiProperty({ type: Number, description: 'seconds' })
  accessTokenExpiresIn: number;
  @ApiProperty({
    type: String,
    required: false,
    description: 'Full scope only.',
  })
  refreshToken?: string;
  @ApiProperty({ type: String, format: 'date-time', required: false })
  refreshTokenExpiresAt?: Date;

  static from(t: PlatformTokens | PasswordChangeToken): PlatformTokensView {
    return t.scope === 'full'
      ? {
          scope: t.scope,
          accessToken: t.accessToken,
          accessTokenExpiresIn: t.accessTokenExpiresIn,
          refreshToken: t.refreshToken,
          refreshTokenExpiresAt: t.refreshTokenExpiresAt,
        }
      : {
          scope: t.scope,
          accessToken: t.accessToken,
          accessTokenExpiresIn: t.accessTokenExpiresIn,
        };
  }
}

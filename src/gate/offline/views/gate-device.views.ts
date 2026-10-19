import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import type {
  DeviceStatus,
  GuardDeviceView,
  StaffDeviceView,
} from '../gate-devices.service';

const STATUSES = ['active', 'revoked'] as const;

/** The device as it learns of itself (ADR 0057). */
export class GuardDeviceResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: STATUSES, enumName: 'GateDeviceStatus' })
  status: DeviceStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  enrolledAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The server’s clock now: the device keeps its offset and times what it records from it.',
  })
  serverTime: Date;

  static from(v: GuardDeviceView): GuardDeviceResponse {
    return { ...v };
  }
}

export class NotCarriedView {
  @ApiProperty({ type: Number })
  passes: number;
  @ApiProperty({ type: Number })
  workers: number;
}

/** A device as the management reads it (ADR 0057). */
export class StaffDeviceResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  label: string | null;
  @ApiProperty({ enum: STATUSES, enumName: 'GateDeviceStatus' })
  status: DeviceStatus;
  @ApiProperty({ type: AccountRefView })
  enrolledBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  enrolledAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  revokedBy: AccountRefView | null;
  @ApiProperty({ enum: [...REASON_CODES.gateDeviceRevoke], nullable: true })
  revokeReasonCode: string | null;
  @ApiProperty({
    type: Number,
    description: 'Its last bundle’s number; 0 before the first.',
  })
  bundleVersion: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastBundleAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Until when its last bundle decides entries.',
  })
  bundleValidUntil: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'Its last bundle’s shift is open.',
  })
  onShift: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Its last call of any kind.',
  })
  lastSeenAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastUploadAt: Date | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Actions it still holds, as its last heartbeat said.',
  })
  pendingCount: number | null;
  @ApiProperty({
    type: Number,
    description: 'Every action up to this one was received.',
  })
  ackedSeq: number;
  @ApiProperty({ type: Number, description: 'The highest action received.' })
  maxSeq: number;
  @ApiProperty({
    type: Number,
    description: 'Actions up to the highest that never arrived.',
  })
  missingActions: number;
  @ApiProperty({
    type: Number,
    description: 'Its flags to look at: neither reviewed nor cleared.',
  })
  openFlags: number;
  @ApiProperty({
    type: NotCarriedView,
    description:
      'What its last bundle could not carry: passes from before ADR 0043 and worker cards from before ADR 0057, which work online only until reissued.',
  })
  notCarried: NotCarriedView;

  static from(v: StaffDeviceView): StaffDeviceResponse {
    return {
      id: v.id,
      label: v.label,
      status: v.status,
      enrolledBy: accountRef(v.enrolledBy),
      enrolledAt: v.enrolledAt,
      revokedAt: v.revokedAt,
      revokedBy: v.revokedBy ? accountRef(v.revokedBy) : null,
      revokeReasonCode: v.revokeReasonCode,
      bundleVersion: v.bundleVersion,
      lastBundleAt: v.lastBundleAt,
      bundleValidUntil: v.bundleValidUntil,
      onShift: v.onShift,
      lastSeenAt: v.lastSeenAt,
      lastUploadAt: v.lastUploadAt,
      pendingCount: v.pendingCount,
      ackedSeq: v.ackedSeq,
      maxSeq: v.maxSeq,
      missingActions: v.missingActions,
      openFlags: v.openFlags,
      notCarried: v.notCarried,
    };
  }
}

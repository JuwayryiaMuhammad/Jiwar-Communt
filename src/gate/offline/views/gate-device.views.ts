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
    };
  }
}

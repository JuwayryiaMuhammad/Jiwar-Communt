import { ApiProperty } from '@nestjs/swagger';
import { REASON_CODES } from '../../../core/common/reasons';
import { dayOf } from '../ban-reads';
import type { BanRead } from '../bans.service';

export class FacilityBanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null: every facility.',
  })
  facilityId: string | null;
  @ApiProperty({
    enum: REASON_CODES.facilityBan,
    enumName: 'FacilityBanReason',
  })
  reasonCode: string;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'The last day it holds, inclusive; null until lifted.',
  })
  endsOn: string | null;
  @ApiProperty({ enum: ['in_force', 'ended', 'lifted'] })
  state: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  liftedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`facilityBanLift`, or the system’s `ended`.',
  })
  liftReasonCode: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    isArray: true,
    description: 'The bookings it cancelled when it started.',
  })
  cancelledBookingIds: string[];

  static from({
    ban: b,
    state,
    cancelledBookingIds,
  }: BanRead): FacilityBanView {
    return {
      id: b.id,
      accountId: b.accountId,
      facilityId: b.facilityId,
      reasonCode: b.reasonCode,
      endsOn: b.endsOn ? dayOf(b.endsOn) : null,
      state,
      createdAt: b.createdAt,
      liftedAt: b.liftedAt,
      liftReasonCode: b.liftReasonCode,
      cancelledBookingIds: [...cancelledBookingIds],
    };
  }
}

/** What the banned account sees of its own ban. */
export class OwnFacilityBanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  facilityId: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  endsOn: string | null;

  static from({ ban: b }: BanRead): OwnFacilityBanView {
    return {
      id: b.id,
      facilityId: b.facilityId,
      endsOn: b.endsOn ? dayOf(b.endsOn) : null,
    };
  }
}

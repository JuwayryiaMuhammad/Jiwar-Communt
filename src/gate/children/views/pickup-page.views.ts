import { ApiProperty } from '@nestjs/swagger';
import { WeeklyScheduleView } from '../../roster/views/roster.views';

const STATUSES = ['active', 'not_yet', 'expired'] as const;
export type PickupPageStatus = (typeof STATUSES)[number];

/** Where the code may be used: a gate or a zone, by name. */
export class PickupPostView {
  @ApiProperty({ type: String, nullable: true, example: 'Main gate' })
  gateName: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Clubhouse' })
  zoneNameEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  zoneNameAr: string | null;
}

/**
 * What an outside escort's pickup page shows (ADR 0054): the compound, the
 * unit, when and where the code works, and the code while it does. Never
 * the child, the household or anyone's name or phone.
 */
export class PickupPageView {
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({ type: String, example: 'A-101' })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date' })
  validFrom: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  validUntil: string | null;
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;
  @ApiProperty({ type: WeeklyScheduleView, nullable: true })
  schedule: WeeklyScheduleView | null;
  @ApiProperty({ type: PickupPostView, nullable: true })
  post: PickupPostView | null;
  @ApiProperty({
    enum: STATUSES,
    enumName: 'PickupPageStatus',
    description: '`not_yet` before its first day, `expired` after its last.',
  })
  status: PickupPageStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The 6-digit code, while the status is `active`.',
  })
  code: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The QR (`JWP1.<token>`), while the status is `active`.',
  })
  qrPayload: string | null;
  @ApiProperty({ type: String, nullable: true })
  visitorDirections: string | null;
  @ApiProperty({ type: String, nullable: true })
  emergencyPhone: string | null;
}

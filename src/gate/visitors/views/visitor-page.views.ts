import { ApiProperty } from '@nestjs/swagger';
import { VisitorPassKind } from '@prisma/client';
import { VisitScheduleDto } from '../dto/visitors.dto';
import type { VisitorPage } from '../visitor-page.service';
import type { PassStatus } from '../visitor-passes.service';

/**
 * The visitor's public page (ADR 0030). Never the host, another resident,
 * the guard, or the visitor's own name or phone.
 */
export class VisitorPageView {
  @ApiProperty({ type: String })
  compoundName: string;

  @ApiProperty({ type: String })
  unitCode: string;

  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  kind: VisitorPassKind;

  @ApiProperty({ type: Number })
  partySize: number;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;

  @ApiProperty({
    type: String,
    example: 'Africa/Cairo',
    description: 'The compound’s IANA zone; the schedule is read in it.',
  })
  timeZone: string;

  @ApiProperty({ type: VisitScheduleDto, nullable: true })
  schedule: VisitScheduleDto | null;

  @ApiProperty({ enum: ['active', 'used', 'cancelled', 'expired'] })
  status: PassStatus;

  @ApiProperty({
    enum: ['host_cancelled', 'wrong_recipient'],
    nullable: true,
    description: 'Cancelled passes only.',
  })
  statusReason: VisitorPage['statusReason'];

  @ApiProperty({
    type: String,
    nullable: true,
    description: '6 digits to type at the gate. Only while active.',
  })
  code: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the QR encodes (`JWR1.<token>`). Only while active.',
  })
  qrPayload: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the compound tells its visitors.',
  })
  visitorDirections: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'E.164.' })
  emergencyPhone: string | null;

  static from(p: VisitorPage): VisitorPageView {
    return {
      compoundName: p.compoundName,
      unitCode: p.unitCode,
      kind: p.kind,
      partySize: p.partySize,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      timeZone: p.timeZone,
      schedule: p.schedule,
      status: p.status,
      statusReason: p.statusReason,
      code: p.code,
      qrPayload: p.qrPayload,
      visitorDirections: p.visitorDirections,
      emergencyPhone: p.emergencyPhone,
    };
  }
}

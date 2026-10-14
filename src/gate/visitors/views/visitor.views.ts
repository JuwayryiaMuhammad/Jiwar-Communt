import { ApiProperty } from '@nestjs/swagger';
import {
  DeliveryInstruction,
  VisitorInstruction,
  VisitorPassKind,
} from '@prisma/client';
import { AccountRefView, accountRef } from '../../../core/common/http/personal';
import type { GateInstructions } from '../instructions.service';
import type {
  IssuedPass,
  PassDetail,
  PassListItem,
  PassStatus,
} from '../visitor-passes.service';
import { VisitorScheduleDto } from '../dto/visitors.dto';

const STATUSES: PassStatus[] = ['active', 'used', 'cancelled', 'expired'];

/** One enum for every view of a pass, each value said (ADR 0043). */
const STATUS = {
  enum: STATUSES,
  enumName: 'VisitorPassStatus',
  description: [
    '- `active`: the code opens the gate (within the dates, and the schedule for a recurring pass).',
    '- `used`: a one-time pass whose visitors all came in (`entriesUsed` reached `partySize`); the code is dead.',
    '- `cancelled`: the host or the primary cancelled it, the visitor said "this isn’t me", or the host can no longer invite; the code is dead.',
    '- `expired`: `validUntil` has passed; the code is dead.',
  ].join('\n'),
} as const;

/** Right after creation or a link reissue: the secrets, shown once (no-store). */
export class IssuedPassView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '6 digits. Null only on a replay of a pass no longer active.',
  })
  code: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://app.jiwar.eg/v#q3Jz…',
    description:
      'The page to send the visitor: the token is in the fragment, which browsers never send to a server (ADR 0030). Null with `code`.',
  })
  link: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'JWR1.q3Jz…',
    description: 'What the visitor’s QR encodes. Null with `code`.',
  })
  qrPayload: string | null;

  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  kind: VisitorPassKind;

  @ApiProperty({ type: Number })
  partySize: number;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;

  @ApiProperty({ type: VisitorScheduleDto, nullable: true })
  schedule: VisitorScheduleDto | null;

  @ApiProperty(STATUS)
  status: PassStatus;

  static from(p: IssuedPass): IssuedPassView {
    return {
      id: p.id,
      code: p.code,
      link: p.link,
      qrPayload: p.qrPayload,
      kind: p.kind,
      partySize: p.partySize,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      schedule: p.schedule,
      status: p.status,
    };
  }
}

export class PassView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  kind: VisitorPassKind;

  @ApiProperty({ type: Number })
  partySize: number;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;

  @ApiProperty({ type: VisitorScheduleDto, nullable: true })
  schedule: VisitorScheduleDto | null;

  @ApiProperty(STATUS)
  status: PassStatus;

  @ApiProperty({ type: Boolean, description: 'The caller is the host.' })
  mine: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "On the caller's own passes only, until the data expires.",
  })
  visitorName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "On the caller's own passes only, until the data expires.",
  })
  vehiclePlate: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'One-time passes: how many of the `partySize` people came in, one per entry (ADR 0043). The pass is `used` when it reaches `partySize`. Null on a recurring pass, whose `partySize` caps how many are inside at once.',
  })
  entriesUsed: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The latest entry through the gate on this pass.',
  })
  enteredAt: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'The latest exit, once everyone who came in on the pass has left; null while anyone is inside.',
  })
  exitedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(p: PassListItem): PassView {
    return {
      id: p.id,
      kind: p.kind,
      partySize: p.partySize,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      schedule: p.schedule,
      status: p.status,
      mine: p.mine,
      visitorName: p.visitorName,
      vehiclePlate: p.vehiclePlate,
      entriesUsed: p.entriesUsed,
      enteredAt: p.enteredAt,
      exitedAt: p.exitedAt,
      createdAt: p.createdAt,
    };
  }
}

/**
 * One pass (ADR 0043), for every member of its unit. The code, QR and link
 * are the ones the create returned, while the pass is active, for its host
 * and the unit's primary; the visitor's data for the host only (no-store).
 */
export class PassDetailView extends PassView {
  @ApiProperty({ type: AccountRefView })
  createdBy: AccountRefView;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '6 digits. Active passes, for the host and the primary; null otherwise, and on a pass issued before this field existed (reissue its link).',
  })
  code: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://app.jiwar.eg/v#q3Jz…',
    description: 'Null with `code`.',
  })
  link: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'JWR1.q3Jz…',
    description: 'Null with `code`.',
  })
  qrPayload: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '••••4567',
    description:
      "The visitor's phone, last four digits only: the host's own passes, until the data expires.",
  })
  visitorPhoneMasked: string | null;

  static fromDetail(p: PassDetail): PassDetailView {
    return {
      ...PassView.from(p),
      createdBy: accountRef(p.createdBy),
      code: p.code,
      link: p.link,
      qrPayload: p.qrPayload,
      visitorPhoneMasked: p.visitorPhoneMasked,
    };
  }
}

export class GateInstructionsView {
  @ApiProperty({ enum: VisitorInstruction, enumName: 'VisitorInstruction' })
  uninvitedVisitor: VisitorInstruction;

  @ApiProperty({ enum: DeliveryInstruction, enumName: 'DeliveryInstruction' })
  delivery: DeliveryInstruction;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null: never set (the defaults apply).',
  })
  updatedAt: Date | null;

  static from(i: GateInstructions): GateInstructionsView {
    return {
      uninvitedVisitor: i.uninvitedVisitor,
      delivery: i.delivery,
      updatedAt: i.updatedAt,
    };
  }
}

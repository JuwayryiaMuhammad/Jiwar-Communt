import { ApiProperty } from '@nestjs/swagger';
import { PresignedReadView } from '../../../../core/files/views/file.views';
import type {
  AreaStageRead,
  DamageClaimRead,
  DebrisSlotRead,
  FitOutRead,
} from '../fitout.service';

/** The finishing-works deposit named on a works permit (ADR 0074). */
export class FitOutDepositView {
  @ApiProperty({ type: String, description: '`DP-` and the number.' })
  number: string;
  @ApiProperty({ type: String, description: 'EGP received.' })
  amount: string;
  @ApiProperty({ type: String, description: 'EGP still held.' })
  held: string;
}

/** A works permit's drawing (ADR 0074). */
export class PermitDrawingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description: 'A read of the image or the PDF; null once it is gone.',
  })
  file: PresignedReadView | null;
}

export class DebrisWindowView {
  @ApiProperty({
    type: String,
    example: '10:00',
    description: '`HH:mm`, local.',
  })
  from: string;
  @ApiProperty({ type: String, example: '12:00' })
  to: string;
}

/** A debris removal of a works permit (ADR 0074): sides and codes, never a person. */
export class DebrisSlotView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date', description: 'The local day.' })
  day: string;
  @ApiProperty({ type: DebrisWindowView })
  window: DebrisWindowView;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: ['scheduled', 'done', 'missed', 'cancelled'] })
  status: string;
  @ApiProperty({ enum: ['resident', 'staff'] })
  scheduledSide: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({ enum: ['staff', 'gate'], nullable: true })
  doneSide: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  missedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ enum: ['resident', 'staff'], nullable: true })
  cancelSide: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.debrisSlotCancel.',
  })
  cancelReason: string | null;

  static from(d: DebrisSlotRead): DebrisSlotView {
    return { ...d, window: { ...d.window } };
  }
}

export class FitOutAreaRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

/** A common area at one stage of the works: the management's photos and note. */
export class AreaStageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({
    type: [PresignedReadView],
    description: 'A read of each photo; null where one is gone.',
  })
  photos: (PresignedReadView | null)[];

  static from(r: AreaStageRead | null): AreaStageView | null {
    return r
      ? {
          id: r.id,
          recordedAt: r.recordedAt,
          note: r.note,
          photos: r.photos.map((ph) => PresignedReadView.from(ph)),
        }
      : null;
  }
}

/** A common area before and after the works (ADR 0074). */
export class FitOutAreaView {
  @ApiProperty({ type: FitOutAreaRefView })
  commonArea: FitOutAreaRefView;
  @ApiProperty({ type: AreaStageView, nullable: true })
  before: AreaStageView | null;
  @ApiProperty({ type: AreaStageView, nullable: true })
  after: AreaStageView | null;
}

export class DamageAppealView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The appellant’s words; null after their erasure.',
  })
  text: string | null;
  @ApiProperty({ type: PresignedReadView, nullable: true })
  photo: PresignedReadView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({ enum: ['upheld', 'accepted'], nullable: true })
  decision: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
}

export class DamageWithdrawnView {
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({
    type: String,
    description: 'REASON_CODES.damageClaimWithdraw.',
  })
  reason: string;
}

export class DamageSettlementView {
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({
    type: String,
    description: 'EGP taken from the works deposit.',
  })
  deducted: string;
  @ApiProperty({
    type: String,
    description: 'EGP left owing as a `damage` invoice.',
  })
  charged: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  invoiceId: string | null;
  @ApiProperty({ enum: ['open', 'paid', 'cancelled'], nullable: true })
  chargeStatus: string | null;
}

/** A damage claim on a works permit (ADR 0074): codes, amounts and words, never a person. */
export class DamageClaimView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'DC-0012' })
  number: string;
  @ApiProperty({ type: String, description: 'REASON_CODES.damageClaim.' })
  reasonCode: string;
  @ApiProperty({ type: String, description: 'The management’s words.' })
  description: string;
  @ApiProperty({ type: String, description: 'EGP.' })
  amount: string;
  @ApiProperty({ enum: ['open', 'under_appeal', 'withdrawn', 'settled'] })
  status: string;
  @ApiProperty({ type: FitOutAreaRefView, nullable: true })
  commonArea: FitOutAreaRefView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  raisedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'The household appeals until then, once.',
  })
  appealUntil: Date;
  @ApiProperty({ type: [PresignedReadView] })
  photos: (PresignedReadView | null)[];
  @ApiProperty({ type: DamageAppealView, nullable: true })
  appeal: DamageAppealView | null;
  @ApiProperty({ type: DamageWithdrawnView, nullable: true })
  withdrawn: DamageWithdrawnView | null;
  @ApiProperty({ type: DamageSettlementView, nullable: true })
  settlement: DamageSettlementView | null;

  static from(c: DamageClaimRead): DamageClaimView {
    return {
      ...c,
      commonArea: c.commonArea ? { ...c.commonArea } : null,
      photos: c.photos.map((ph) => PresignedReadView.from(ph)),
      appeal: c.appeal
        ? { ...c.appeal, photo: PresignedReadView.from(c.appeal.photo) }
        : null,
      withdrawn: c.withdrawn ? { ...c.withdrawn } : null,
      settlement: c.settlement ? { ...c.settlement } : null,
    };
  }
}

/**
 * A works permit's fit-out (ADR 0074): its deposit, its drawings — for
 * its household (the requester, the unit's primary) and the management.
 */
export class FitOutView {
  @ApiProperty({ type: String, format: 'uuid' })
  permitId: string;
  @ApiProperty({ type: String, example: 'W-0042' })
  reference: string;
  @ApiProperty({
    enum: [
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'revoked',
      'used',
      'ended',
    ],
  })
  status: string;
  @ApiProperty({
    type: Boolean,
    description:
      'The compound approves works only once a deposit named on them holds money.',
  })
  depositRequired: boolean;
  @ApiProperty({ type: FitOutDepositView, nullable: true })
  deposit: FitOutDepositView | null;
  @ApiProperty({ type: [PermitDrawingView], description: 'Oldest first.' })
  drawings: PermitDrawingView[];
  @ApiProperty({ type: [DebrisSlotView], description: 'By their window.' })
  debrisSlots: DebrisSlotView[];
  @ApiProperty({
    type: [FitOutAreaView],
    description: 'Each common area recorded, before the works and after them.',
  })
  areas: FitOutAreaView[];
  @ApiProperty({ type: [DamageClaimView], description: 'Newest first.' })
  claims: DamageClaimView[];

  static from(r: FitOutRead): FitOutView {
    return {
      permitId: r.permitId,
      reference: r.reference,
      status: r.status,
      depositRequired: r.depositRequired,
      deposit: r.deposit ? { ...r.deposit } : null,
      drawings: r.drawings.map((d) => ({
        id: d.id,
        addedAt: d.addedAt,
        file: PresignedReadView.from(d.file),
      })),
      debrisSlots: r.debrisSlots.map((d) => DebrisSlotView.from(d)),
      areas: r.areas.map((a) => ({
        commonArea: { ...a.commonArea },
        before: AreaStageView.from(a.before),
        after: AreaStageView.from(a.after),
      })),
      claims: r.claims.map((c) => DamageClaimView.from(c)),
    };
  }
}

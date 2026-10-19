import { ApiProperty } from '@nestjs/swagger';
import type { UnitViolationPayment } from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { PlaceView } from '../../places/views/place.views';
import { PostView } from '../../roster/views/roster.views';
import { safetyReference } from '../../safety/safety-rules';
import { dayOf } from '../../vehicles/vehicle-rules';
import type { ViolationFile } from '../violations.service';

const STATUSES = ['open', 'under_appeal', 'paid', 'cancelled'] as const;

/** A violation's appeal as the unit's people see it. */
export class ViolationAppealView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The appellant’s words; null once the appellant was erased.',
  })
  reason: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned URL, valid for minutes.',
  })
  photoUrl: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  appealedAt: Date;
  @ApiProperty({
    enum: ['upheld', 'cancelled'],
    enumName: 'ViolationDecision',
    nullable: true,
  })
  decision: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
}

/**
 * A violation as the unit's people see it (ADR 0053): what, where, when,
 * the note and the photo, the amount (or none: a warning). Never who
 * issued it.
 */
export class ResidentViolationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'V-0042' })
  reference: string;
  @ApiProperty({
    enum: [...REASON_CODES.violationKind],
    enumName: 'ViolationKind',
  })
  kind: string;
  @ApiProperty({ type: String, description: 'The local day, `YYYY-MM-DD`.' })
  date: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'W-0042',
    description: 'Contractor hours: the works permit.',
  })
  permitReference: string | null;
  @ApiProperty({ type: PlaceView, nullable: true })
  place: PlaceView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '500.00',
    description: 'EGP, two decimals; null: a warning.',
  })
  amount: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['EGP'] })
  currency: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'No amount: a warning, never paid.',
  })
  isWarning: boolean;
  @ApiProperty({ enum: STATUSES, enumName: 'ViolationStatus' })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Words the unit reads.',
  })
  note: string | null;
  @ApiProperty({ type: String, nullable: true })
  photoUrl: string | null;
  @ApiProperty({ type: ViolationAppealView, nullable: true })
  appeal: ViolationAppealView | null;
  @ApiProperty({
    enum: [
      ...REASON_CODES.violationCancel,
      ...REASON_CODES.violationSystemCancel,
    ],
    enumName: 'ViolationCancel',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'The caller may appeal it now: open, never appealed, within 30 days, a keeper of the unit or its primary.',
  })
  canAppeal: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Its appeal upheld: until when an owner or the primary may take it to the board (POST /governance/board-appeals, ADR 0055).',
  })
  boardAppealUntil: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When it was taken to the board; no payment until the board decides.',
  })
  boardAppealAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(f: ViolationFile): ResidentViolationView {
    const v = f.violation;
    return {
      id: v.id,
      reference: safetyReference('V', v.number),
      kind: v.kind,
      date: dayOf(v.occurredOn)!,
      permitReference: f.permitReference,
      place: f.place && { ...f.place },
      amount: v.amount ? v.amount.toFixed(2) : null,
      currency: v.currency,
      isWarning: v.amount === null,
      status: v.status,
      note: v.note,
      photoUrl: f.photoUrl,
      appeal: v.appealedAt
        ? {
            reason: v.appealText,
            photoUrl: f.appealPhotoUrl,
            appealedAt: v.appealedAt,
            decision: v.appealDecision,
            decidedAt: v.decidedAt,
          }
        : null,
      cancelReason: v.cancelReason,
      canAppeal: f.canAppeal,
      boardAppealUntil: f.boardAppealUntil,
      boardAppealAt: v.boardAppealAt,
      createdAt: v.createdAt,
    };
  }
}

/** What a guard sees of the violation they issued. */
export class GuardViolationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'V-0042' })
  reference: string;
  @ApiProperty({
    enum: [...REASON_CODES.violationKind],
    enumName: 'ViolationKind',
  })
  kind: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, description: '`YYYY-MM-DD`.' })
  date: string;
  @ApiProperty({ type: String, nullable: true })
  amount: string | null;
  @ApiProperty({ enum: STATUSES, enumName: 'ViolationStatus' })
  status: string;

  static from(f: ViolationFile): GuardViolationView {
    const v = f.violation;
    return {
      id: v.id,
      reference: safetyReference('V', v.number),
      kind: v.kind,
      unitCode: f.unitCode,
      date: dayOf(v.occurredOn)!,
      amount: v.amount ? v.amount.toFixed(2) : null,
      status: v.status,
    };
  }
}

/** A payment or a reversal. Amounts in EGP, two decimals; days are local. */
export class ViolationPaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  violationId: string;
  @ApiProperty({ enum: ['payment', 'reversal'] })
  kind: string;
  @ApiProperty({ type: String, nullable: true })
  amount: string | null;
  @ApiProperty({ type: String, nullable: true })
  currency: string | null;
  @ApiProperty({ type: String, nullable: true })
  receiptNumber: string | null;
  @ApiProperty({ type: String, nullable: true, description: '`YYYY-MM-DD`.' })
  paidOn: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reversesId: string | null;
  @ApiProperty({
    enum: [...REASON_CODES.violationPaymentReverse],
    enumName: 'ViolationPaymentReverse',
    nullable: true,
  })
  reasonCode: string | null;
  @ApiProperty({ type: AccountRefView })
  recordedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(p: UnitViolationPayment, f: ViolationFile): ViolationPaymentView {
    const by = f.people.get(p.recordedById);
    return {
      id: p.id,
      violationId: p.violationId,
      kind: p.kind,
      amount: p.amount ? p.amount.toFixed(2) : null,
      currency: p.currency,
      receiptNumber: p.receiptNumber,
      paidOn: dayOf(p.paidOn),
      reversesId: p.reversesId,
      reasonCode: p.reasonCode,
      recordedBy: by ? accountRef(by) : { id: p.recordedById, erased: true },
      createdAt: p.createdAt,
    };
  }
}

/** A violation as the staff see it: the unit, who did what, the payments. */
export class StaffViolationView extends ResidentViolationView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  permitId: string | null;
  @ApiProperty({ type: AccountRefView })
  issuedBy: AccountRefView;
  @ApiProperty({
    type: PostView,
    nullable: true,
    description: 'A guard’s: the post of their shift.',
  })
  post: PostView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  appealedBy: AccountRefView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  cancelledBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: [ViolationPaymentView] })
  payments: ViolationPaymentView[];

  static from(f: ViolationFile): StaffViolationView {
    const v = f.violation;
    const ref = (id: string | null) => {
      const p = id ? f.people.get(id) : undefined;
      return p ? accountRef(p) : id ? { id, erased: true as const } : null;
    };
    return {
      ...ResidentViolationView.from(f),
      canAppeal: false,
      unitId: v.unitId,
      unitCode: f.unitCode,
      permitId: v.permitId,
      issuedBy: ref(v.issuedById)!,
      post: f.post,
      appealedBy: ref(v.appealedById),
      decidedBy: ref(v.decidedById),
      cancelledBy: ref(v.cancelledById),
      cancelledAt: v.cancelledAt,
      payments: f.payments.map((p) => ViolationPaymentView.from(p, f)),
    };
  }
}

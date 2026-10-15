import { ApiProperty } from '@nestjs/swagger';
import {
  VehicleFineDecision,
  VehicleFinePaymentKind,
  VehicleFineStatus,
  type VehicleFinePayment,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { dayOf, reference } from '../../vehicles/vehicle-rules';
import type { FineFile } from '../fines.service';

/** A fine's appeal as the unit's people see it. */
export class FineAppealView {
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
    enum: VehicleFineDecision,
    enumName: 'VehicleFineDecision',
    nullable: true,
  })
  decision: VehicleFineDecision | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
}

/** A unit's fine as its people see it (ADR 0045). Never where it came from. */
export class ResidentFineView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'F-0042' })
  reference: string;
  @ApiProperty({
    type: String,
    description: 'From the closed list `vehicleFineReason`.',
  })
  reason: string;
  @ApiProperty({
    type: String,
    description: 'The local day it happened, `YYYY-MM-DD`.',
  })
  date: string;
  @ApiProperty({ type: String })
  plate: string;
  @ApiProperty({
    type: String,
    example: '500.00',
    description: 'EGP, two decimals.',
  })
  amount: string;
  @ApiProperty({ type: String, enum: ['EGP'] })
  currency: string;
  @ApiProperty({
    enum: VehicleFineStatus,
    enumName: 'VehicleFineStatus',
    description: '`paid` at the office (no online payment yet).',
  })
  status: VehicleFineStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The staff’s words.',
  })
  note: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned URL, valid for minutes.',
  })
  photoUrl: string | null;
  @ApiProperty({ type: FineAppealView, nullable: true })
  appeal: FineAppealView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it was cancelled: `vehicleFineCancel`.',
  })
  cancelReason: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'The caller may appeal it now: unpaid, never appealed, within 30 days, a vehicle keeper of the unit or its primary.',
  })
  canAppeal: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(f: FineFile): ResidentFineView {
    const v = f.fine;
    return {
      id: v.id,
      reference: reference('F', v.number),
      reason: v.reason,
      date: dayOf(v.occurredOn)!,
      plate: v.plate,
      amount: v.amount.toFixed(2),
      currency: v.currency,
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
      createdAt: v.createdAt,
    };
  }
}

/** A payment or a reversal. Amounts in EGP, two decimals; days are local. */
export class FinePaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  fineId: string;
  @ApiProperty({
    enum: VehicleFinePaymentKind,
    enumName: 'VehicleFinePaymentKind',
  })
  kind: VehicleFinePaymentKind;
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
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(p: VehicleFinePayment): FinePaymentView {
    return {
      id: p.id,
      fineId: p.fineId,
      kind: p.kind,
      amount: p.amount ? p.amount.toFixed(2) : null,
      currency: p.currency,
      receiptNumber: p.receiptNumber,
      paidOn: dayOf(p.paidOn),
      reversesId: p.reversesId,
      reasonCode: p.reasonCode,
      createdAt: p.createdAt,
    };
  }
}

/** One payment line for the staff: who recorded it. */
export class StaffFinePaymentView extends FinePaymentView {
  @ApiProperty({ type: AccountRefView })
  recordedBy: AccountRefView;
}

/** A fine as the staff see it: the unit, the appeal, the payments, who did what. */
export class StaffFineView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'F-0042' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  vehicleId: string | null;
  @ApiProperty({ type: String })
  plate: string;
  @ApiProperty({ type: String })
  reason: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, description: 'EGP, two decimals.' })
  amount: string;
  @ApiProperty({ type: String })
  currency: string;
  @ApiProperty({ type: String, description: '`YYYY-MM-DD`.' })
  occurredOn: string;
  @ApiProperty({ enum: VehicleFineStatus, enumName: 'VehicleFineStatus' })
  status: VehicleFineStatus;
  @ApiProperty({ type: String, nullable: true })
  photoUrl: string | null;
  @ApiProperty({ type: AccountRefView })
  issuedBy: AccountRefView;
  @ApiProperty({ type: FineAppealView, nullable: true })
  appeal: FineAppealView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  appealedBy: AccountRefView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  cancelledBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: [StaffFinePaymentView] })
  payments: StaffFinePaymentView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(f: FineFile): StaffFineView {
    const v = f.fine;
    const ref = (id: string | null) => {
      const p = id ? f.people.get(id) : undefined;
      return p ? accountRef(p) : null;
    };
    return {
      id: v.id,
      reference: reference('F', v.number),
      unitId: v.unitId,
      unitCode: f.unitCode,
      vehicleId: v.vehicleId,
      plate: v.plate,
      reason: v.reason,
      note: v.note,
      amount: v.amount.toFixed(2),
      currency: v.currency,
      occurredOn: dayOf(v.occurredOn)!,
      status: v.status,
      photoUrl: f.photoUrl,
      issuedBy: ref(v.issuedById)!,
      appeal: v.appealedAt
        ? {
            reason: v.appealText,
            photoUrl: f.appealPhotoUrl,
            appealedAt: v.appealedAt,
            decision: v.appealDecision,
            decidedAt: v.decidedAt,
          }
        : null,
      appealedBy: ref(v.appealedById),
      decidedBy: ref(v.decidedById),
      cancelReason: v.cancelReason,
      cancelledBy: ref(v.cancelledById),
      cancelledAt: v.cancelledAt,
      payments: f.payments.map((p) => ({
        ...FinePaymentView.from(p),
        recordedBy: ref(p.recordedById)!,
      })),
      createdAt: v.createdAt,
    };
  }
}

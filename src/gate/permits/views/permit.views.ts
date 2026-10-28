import { ApiProperty } from '@nestjs/swagger';
import {
  IdDocumentType,
  UnitPermitKind,
  type PermitGuest,
  type PermitWorker,
} from '@prisma/client';
import { localDate } from '../../../core/common/slots/day-slots';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { PresignedReadView } from '../../../core/files/views/file.views';
import { permitReference } from '../permit-core';
import { timeOf } from '../permit-rules';
import { viewStatus, type PermitRecord } from '../permit-records';

export const PERMIT_VIEW_STATUSES = [
  'pending',
  'approved',
  'ended',
  'rejected',
  'cancelled',
  'revoked',
  'used',
] as const;

const STATUS_TEXT =
  '`pending`: waiting for the management; `approved`: in force within its window; `ended`: approved and its window has passed; `rejected`; `cancelled` (by the requester, or by the system: the requester left, or nobody decided in time); `revoked` by the management; `used`: a material exit, at a gate.';

export class PermitHoursView {
  @ApiProperty({ type: String, example: '09:00' })
  from: string;
  @ApiProperty({ type: String, example: '17:00' })
  to: string;
}

/** A contractor worker as the household and the management see them. */
export class PermitWorkerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once purged, 30 days after the permit ended.',
  })
  fullName: string | null;
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  idType: IdDocumentType;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description:
      'Their face, a presigned read valid for minutes; null once purged. The last four of their ID are never shown again.',
  })
  photo: PresignedReadView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  removedAt: Date | null;
  @ApiProperty({
    enum: ['requester', 'management'],
    nullable: true,
    description: 'Who removed them.',
  })
  removedBy: 'requester' | 'management' | null;

  static from(w: PermitWorker, r: PermitRecord): PermitWorkerView {
    return {
      id: w.id,
      fullName: w.fullName,
      idType: w.idType,
      photo: PresignedReadView.from(
        (w.photoFileId && r.photos.get(w.photoFileId)) || null,
      ),
      addedAt: w.createdAt,
      removedAt: w.removedAt,
      removedBy: w.removedSide as 'requester' | 'management' | null,
    };
  }
}

/** An event's guest. */
export class PermitGuestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once purged, 30 days after the event.',
  })
  fullName: string | null;
  @ApiProperty({ type: String, nullable: true })
  vehiclePlate: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  removedAt: Date | null;

  static from(g: PermitGuest): PermitGuestView {
    return {
      id: g.id,
      fullName: g.fullName,
      vehiclePlate: g.vehiclePlate,
      removedAt: g.removedAt,
    };
  }
}

/** Work stopped on a works permit (ADR 0053): since when, and why. */
export class WorkStoppedView {
  @ApiProperty({ type: String, format: 'date-time' })
  since: Date;
  @ApiProperty({
    enum: [...REASON_CODES.permitWorkStop],
    enumName: 'PermitWorkStop',
  })
  reasonCode: string;
}

export function workStoppedOf(r: PermitRecord): WorkStoppedView | null {
  return r.workStop
    ? { since: r.workStop.stoppedAt, reasonCode: r.workStop.reasonCode }
    : null;
}

export class WorksDetailsView {
  @ApiProperty({
    enum: [...REASON_CODES.permitWorkType],
    enumName: 'PermitWorkType',
  })
  workType: string;
  @ApiProperty({ type: String, example: '2026-11-01', description: 'Local.' })
  startsOn: string;
  @ApiProperty({ type: String, example: '2026-11-20', description: 'Local.' })
  endsOn: string;
  @ApiProperty({
    type: PermitHoursView,
    description: 'Every day of the period, in the compound’s time zone.',
  })
  dailyHours: PermitHoursView;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the requester was erased.',
  })
  contractorCompany: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the requester was erased.',
  })
  description: string | null;
  @ApiProperty({
    type: Number,
    description: 'Workers on the permit now (not removed).',
  })
  workerCount: number;
  @ApiProperty({
    type: [PermitWorkerView],
    description: 'Every worker, removed ones too, in the order added.',
  })
  workers: PermitWorkerView[];
  @ApiProperty({
    type: WorkStoppedView,
    nullable: true,
    description:
      'Security stopped the work (ADR 0053): its workers are refused at the gate until the management resumes it.',
  })
  workStopped: WorkStoppedView | null;
}

export class MoveDetailsView {
  @ApiProperty({ type: String, example: '2026-11-05', description: 'Local.' })
  date: string;
  @ApiProperty({ type: PermitHoursView })
  window: PermitHoursView;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once purged, 30 days after the move.',
  })
  truckPlate: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the requester was erased.',
  })
  itemsDescription: string | null;
  @ApiProperty({
    enum: ['in', 'out'],
    nullable: true,
    description: 'Null on a permit from before directions (ADR 0063).',
  })
  direction: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The move it serves, when one was planned (ADR 0063).',
  })
  moveId: string | null;
}

export class MaterialItemView {
  @ApiProperty({ type: String, example: 'Old tiles' })
  name: string;
  @ApiProperty({ type: Number, example: 20 })
  quantity: number;
}

export class MaterialExitDetailsView {
  @ApiProperty({ type: String, example: '2026-11-05', description: 'Local.' })
  validFrom: string;
  @ApiProperty({ type: String, example: '2026-11-07', description: 'Local.' })
  validUntil: string;
  @ApiProperty({
    type: [MaterialItemView],
    nullable: true,
    description: 'Null once the requester was erased.',
  })
  items: MaterialItemView[] | null;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description:
      'The goods, a presigned read valid for minutes; null when none, or once purged or erased.',
  })
  photo: PresignedReadView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  usedAt: Date | null;
}

export class EventDetailsView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when none, or once the host was erased.',
  })
  title: string | null;
  @ApiProperty({
    type: Number,
    description:
      'The guests the event may hold: 20 when approved at once, else the size the management was asked for.',
  })
  guestLimit: number;
  @ApiProperty({
    type: Number,
    description: 'Guests on the list now (not removed).',
  })
  guestCount: number;
  @ApiProperty({
    type: [PermitGuestView],
    description: 'Every guest, removed ones too, in the order added.',
  })
  guests: PermitGuestView[];
}

/** What every view of a permit shows (ADR 0049). */
export class PermitBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    example: 'W-0042',
    description:
      'W- works, M- moves, X- material exits, E- events. The guard finds a permit by it.',
  })
  reference: string;
  @ApiProperty({ enum: UnitPermitKind, enumName: 'UnitPermitKind' })
  kind: UnitPermitKind;
  @ApiProperty({
    enum: PERMIT_VIEW_STATUSES,
    enumName: 'PermitViewStatus',
    description: STATUS_TEXT,
  })
  status: (typeof PERMIT_VIEW_STATUSES)[number];
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, example: 'B-12' })
  unitCode: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When it starts: the first day’s local midnight (works, a material exit), or the window’s start.',
  })
  startsAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When it ends (exclusive).',
  })
  endsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    enum: ['manager', 'auto'],
    nullable: true,
    description:
      '`auto`: an event of 20 guests or fewer, approved at once. Null while pending.',
  })
  decisionSource: 'manager' | 'auto' | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.unitPermitReject],
    enumName: 'UnitPermitRejectReason',
    nullable: true,
  })
  rejectReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.unitPermitRevoke],
    enumName: 'UnitPermitRevokeReason',
    nullable: true,
  })
  revokeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ enum: ['requester', 'system'], nullable: true })
  cancelledBy: 'requester' | 'system' | null;
  @ApiProperty({
    enum: [
      ...REASON_CODES.unitPermitCancel,
      ...REASON_CODES.unitPermitSystemCancel,
    ],
    enumName: 'UnitPermitCancelReason',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({ type: WorksDetailsView, nullable: true })
  works: WorksDetailsView | null;
  @ApiProperty({ type: MoveDetailsView, nullable: true })
  move: MoveDetailsView | null;
  @ApiProperty({ type: MaterialExitDetailsView, nullable: true })
  materialExit: MaterialExitDetailsView | null;
  @ApiProperty({ type: EventDetailsView, nullable: true })
  event: EventDetailsView | null;

  static base(r: PermitRecord): PermitBaseView {
    const p = r.permit;
    const lastDay = (end: Date) =>
      localDate(new Date(end.getTime() - 1), r.timeZone);
    const firstDay = (start: Date) => localDate(start, r.timeZone);
    const hours = (from: number, to: number) => ({
      from: timeOf(from),
      to: timeOf(to),
    });
    const local = (at: Date) => {
      const t = new Intl.DateTimeFormat('en-GB', {
        timeZone: r.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at);
      return t;
    };
    const items = p.items as { name: string; quantity: number }[] | null;
    return {
      id: p.id,
      reference: permitReference(p.kind, p.number),
      kind: p.kind,
      status: viewStatus(p, r.now),
      unitId: p.unitId,
      unitCode: r.location.unitCode,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      createdAt: p.createdAt,
      decisionSource: p.decisionSource as 'manager' | 'auto' | null,
      decidedAt: p.decidedAt,
      rejectReason: p.rejectReason,
      revokedAt: p.revokedAt,
      revokeReason: p.revokeReason,
      cancelledAt: p.cancelledAt,
      cancelledBy: p.cancelSide as 'requester' | 'system' | null,
      cancelReason: p.cancelReason,
      works:
        p.kind === 'works'
          ? {
              workType: p.workType!,
              startsOn: firstDay(p.startsAt),
              endsOn: lastDay(p.endsAt),
              dailyHours: hours(p.dailyFrom!, p.dailyTo!),
              contractorCompany: p.contractorCompany,
              description: p.description,
              workerCount: r.workers.filter((w) => !w.removedAt).length,
              workers: r.workers.map((w) => PermitWorkerView.from(w, r)),
              workStopped: workStoppedOf(r),
            }
          : null,
      move:
        p.kind === 'move'
          ? {
              date: firstDay(p.startsAt),
              window: { from: local(p.startsAt), to: local(p.endsAt) },
              truckPlate: p.truckPlate,
              itemsDescription: p.itemsDescription,
              direction: p.moveDirection,
              moveId: p.moveId,
            }
          : null,
      materialExit:
        p.kind === 'material_exit'
          ? {
              validFrom: firstDay(p.startsAt),
              validUntil: lastDay(p.endsAt),
              items: items ? items.map((i) => ({ ...i })) : null,
              photo: PresignedReadView.from(
                (p.photoFileId && r.photos.get(p.photoFileId)) || null,
              ),
              usedAt: p.usedAt,
            }
          : null,
      event:
        p.kind === 'event'
          ? {
              title: p.title,
              guestLimit: p.guestLimit!,
              guestCount: r.guests.filter((g) => !g.removedAt).length,
              guests: r.guests.map((g) => PermitGuestView.from(g)),
            }
          : null,
    };
  }
}

/** The household's view (ADR 0049): never the management's notes. */
export class PermitView extends PermitBaseView {
  @ApiProperty({
    type: Boolean,
    description: 'The caller asked for it (else: the unit’s primary sees it).',
  })
  mine: boolean;
  @ApiProperty({ type: FirstNameRefView })
  requestedBy: FirstNameRefView;

  static from(r: PermitRecord, me: string): PermitView {
    return {
      ...PermitBaseView.base(r),
      mine: r.permit.requestedById === me,
      requestedBy: firstNameRef(r.requester),
    };
  }
}

/** Who is locked out of a contractor's ID check now (ADR 0049). */
export class PermitLockoutsView {
  @ApiProperty({
    type: [String],
    description:
      'Workers of this permit locked out (ten wrong last-fours in a day).',
  })
  workerIds: string[];
  @ApiProperty({
    type: [FirstNameRefView],
    description:
      'Guards locked out (five wrong last-fours in 15 minutes, on any permit).',
  })
  guards: FirstNameRefView[];
}

/** The management's view (ADR 0049): the requester and the staff's notes. */
export class StaffPermitView extends PermitBaseView {
  @ApiProperty({ type: AccountRefView })
  requestedBy: AccountRefView;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The management’s note on deciding. Never shown to the unit.',
  })
  staffNote: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The management’s note on revoking. Never shown to the unit.',
  })
  revokeNote: string | null;
  @ApiProperty({
    type: PermitLockoutsView,
    nullable: true,
    description:
      'Works, on one permit: who is locked out of the ID check now; null in lists.',
  })
  lockouts: PermitLockoutsView | null;

  static from(
    r: PermitRecord,
    lockouts: PermitLockoutsView | null = null,
  ): StaffPermitView {
    return {
      ...PermitBaseView.base(r),
      requestedBy: accountRef(r.requester),
      building: r.location.building,
      staffNote: r.permit.staffNote,
      revokeNote: r.permit.revokeNote,
      lockouts,
    };
  }
}

/** A works permit whose work a guard stopped (ADR 0053), as they see it. */
export class GuardWorkStopView {
  @ApiProperty({ type: String, format: 'uuid' })
  permitId: string;
  @ApiProperty({ type: String, example: 'W-0042' })
  reference: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: WorkStoppedView })
  workStopped: WorkStoppedView;

  static from(r: PermitRecord): GuardWorkStopView {
    return {
      permitId: r.permit.id,
      reference: permitReference(r.permit.kind, r.permit.number),
      unitCode: r.location.unitCode,
      workStopped: workStoppedOf(r)!,
    };
  }
}

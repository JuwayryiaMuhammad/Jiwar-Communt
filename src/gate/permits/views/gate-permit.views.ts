import { ApiProperty } from '@nestjs/swagger';
import { IdDocumentType, UnitPermitKind } from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import { PresignedReadView } from '../../../core/files/views/file.views';
import { hoursToday, type GatePermitRecord } from '../gate-permits.service';
import { permitReference } from '../permit-core';
import { viewStatus } from '../permit-records';
import { timeOf } from '../permit-rules';
import {
  MaterialItemView,
  PERMIT_VIEW_STATUSES,
  PermitHoursView,
  workStoppedOf,
  WorkStoppedView,
} from './permit.views';

/** A contractor worker as the guard sees them: never the ID's last four. */
export class GatePermitWorkerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  idType: IdDocumentType;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description:
      'Their face, to match before typing the last four of the ID they show. Only on one permit.',
  })
  photo: PresignedReadView | null;
  @ApiProperty({
    type: Boolean,
    description: 'Taken off the permit: refused (`worker_removed`).',
  })
  removed: boolean;
  @ApiProperty({ type: Boolean, description: 'In the compound now.' })
  inside: boolean;
}

/** An event's guest, for the guard to check names while the event is on. */
export class GatePermitGuestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ type: String, nullable: true })
  vehiclePlate: string | null;
  @ApiProperty({ type: Boolean })
  removed: boolean;
  @ApiProperty({ type: Boolean })
  inside: boolean;
}

export class GateWorksView {
  @ApiProperty({
    enum: [...REASON_CODES.permitWorkType],
    enumName: 'PermitWorkType',
  })
  workType: string;
  @ApiProperty({ type: String, nullable: true })
  contractorCompany: string | null;
  @ApiProperty({ type: [GatePermitWorkerView] })
  workers: GatePermitWorkerView[];
  @ApiProperty({
    type: WorkStoppedView,
    nullable: true,
    description:
      'Work stopped (ADR 0053): its workers are refused (`work_stopped`) until the management resumes it.',
  })
  workStopped: WorkStoppedView | null;
}

export class GateMoveView {
  @ApiProperty({ type: PermitHoursView })
  window: PermitHoursView;
  @ApiProperty({ type: String, nullable: true })
  truckPlate: string | null;
  @ApiProperty({ type: String, nullable: true })
  itemsDescription: string | null;
  @ApiProperty({ type: Boolean, description: 'The truck is inside now.' })
  inside: boolean;
}

export class GateMaterialExitView {
  @ApiProperty({ type: [MaterialItemView], nullable: true })
  items: MaterialItemView[] | null;
  @ApiProperty({ type: PresignedReadView, nullable: true })
  photo: PresignedReadView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  usedAt: Date | null;
}

export class GateEventView {
  @ApiProperty({ type: String, nullable: true })
  title: string | null;
  @ApiProperty({ type: Number })
  guestCount: number;
  @ApiProperty({
    type: [GatePermitGuestView],
    nullable: true,
    description:
      'The names to check, from half an hour before the start to the end; null otherwise.',
  })
  guests: GatePermitGuestView[] | null;
}

/** A permit as the guard sees it (ADR 0049). */
export class GatePermitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'W-0042' })
  reference: string;
  @ApiProperty({ enum: UnitPermitKind, enumName: 'UnitPermitKind' })
  kind: UnitPermitKind;
  @ApiProperty({ enum: PERMIT_VIEW_STATUSES, enumName: 'PermitViewStatus' })
  status: (typeof PERMIT_VIEW_STATUSES)[number];
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    type: PermitHoursView,
    nullable: true,
    description:
      'Works and moves: when they may go on today, inside the compound’s hours as they stand now; null on a day off (and for the other kinds).',
  })
  hoursToday: PermitHoursView | null;
  @ApiProperty({ type: GateWorksView, nullable: true })
  works: GateWorksView | null;
  @ApiProperty({ type: GateMoveView, nullable: true })
  move: GateMoveView | null;
  @ApiProperty({ type: GateMaterialExitView, nullable: true })
  materialExit: GateMaterialExitView | null;
  @ApiProperty({ type: GateEventView, nullable: true })
  event: GateEventView | null;

  static from(r: GatePermitRecord): GatePermitView {
    const p = r.permit;
    const photo = (id: string | null) =>
      PresignedReadView.from((id && r.photos.get(id)) || null);
    const hours = hoursToday(r);
    const local = (at: Date) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: r.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at);
    const items = p.items as { name: string; quantity: number }[] | null;
    return {
      id: p.id,
      reference: permitReference(p.kind, p.number),
      kind: p.kind,
      status: viewStatus(p, r.now),
      unitCode: r.location.unitCode,
      building: r.location.building,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      hoursToday: hours
        ? { from: timeOf(hours.from), to: timeOf(hours.to) }
        : null,
      works:
        p.kind === 'works'
          ? {
              workType: p.workType!,
              contractorCompany: p.contractorCompany,
              workers: r.workers.map((w) => ({
                id: w.id,
                fullName: w.fullName,
                idType: w.idType,
                photo: photo(w.photoFileId),
                removed: w.removedAt !== null || w.purgedAt !== null,
                inside: r.inside.has(w.id),
              })),
              workStopped: workStoppedOf(r),
            }
          : null,
      move:
        p.kind === 'move'
          ? {
              window: { from: local(p.startsAt), to: local(p.endsAt) },
              truckPlate: p.truckPlate,
              itemsDescription: p.itemsDescription,
              inside: r.inside.has(p.id),
            }
          : null,
      materialExit:
        p.kind === 'material_exit'
          ? {
              items: items ? items.map((i) => ({ ...i })) : null,
              photo: photo(p.photoFileId),
              usedAt: p.usedAt,
            }
          : null,
      event:
        p.kind === 'event'
          ? {
              title: p.title,
              guestCount: r.guests.filter((g) => !g.removedAt).length,
              guests: r.guestsShown
                ? r.guests.map((g) => ({
                    id: g.id,
                    fullName: g.fullName,
                    vehiclePlate: g.vehiclePlate,
                    removed: g.removedAt !== null || g.purgedAt !== null,
                    inside: r.inside.has(g.id),
                  }))
                : null,
            }
          : null,
    };
  }
}

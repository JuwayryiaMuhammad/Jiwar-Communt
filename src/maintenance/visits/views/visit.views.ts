import { ApiProperty } from '@nestjs/swagger';
import {
  TicketStatus,
  VisitEventKind,
  VisitReceiverKind,
  VisitSide,
  VisitStatus,
  type TicketVisit,
} from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  erased,
  firstNameOf,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { TicketCategoryRefView } from '../../categories/views/category.views';
import type { Person } from '../../tickets/tickets.service';
import { ticketNumber } from '../../tickets/ticket-rules';
import type { UnitVisitRead, VisitRead } from '../visits.service';

// ============================================================================
// One view per audience (ADR 0034). A visit's window, consent and receiver
// tell when a home is empty: the assigned technician, dispatch and the
// residents of the unit only. The technician sees whether entry is allowed
// and the receiver's first name and kind, never who granted, never the
// receiver's id.
// ============================================================================

function person(people: Map<string, Person>, id: string): Person {
  return people.get(id) ?? { id, fullName: null, status: 'erased' };
}

const first = (r: VisitRead, id: string) => firstNameRef(person(r.people, id));
const full = (r: VisitRead, id: string | null) =>
  id ? accountRef(person(r.people, id)) : null;

export class VisitCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: VisitStatus, enumName: 'VisitStatus' })
  status: VisitStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static from(v: TicketVisit): VisitCreatedView {
    return {
      id: v.id,
      status: v.status,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
    };
  }
}

export class ConsenterView extends FirstNameRefView {
  @ApiProperty({ type: Boolean, description: 'The reader granted it.' })
  mine: boolean;
}

/** Absence-entry consent, as residents see it: never implied. */
export class AbsenceEntryView {
  @ApiProperty({
    type: Boolean,
    description:
      'The technician may enter while nobody is home, for this visit only. False unless someone who lives there said so.',
  })
  approved: boolean;
  @ApiProperty({ type: ConsenterView, nullable: true })
  grantedBy: ConsenterView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  grantedAt: Date | null;
}

export class ResidentReceiverView {
  @ApiProperty({ enum: VisitReceiverKind, enumName: 'VisitReceiverKind' })
  kind: VisitReceiverKind;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The household account, or the worker’s engagement.',
  })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  firstName: string | null;
}

/** What every resident visit view shares. */
class ResidentVisitBase {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: VisitStatus, enumName: 'VisitStatus' })
  status: VisitStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide' })
  proposedBySide: VisitSide;
  @ApiProperty({ type: FirstNameRefView })
  technician: FirstNameRefView;
  @ApiProperty({ type: AbsenceEntryView })
  absenceEntry: AbsenceEntryView;
  @ApiProperty({ type: ResidentReceiverView, nullable: true })
  receiver: ResidentReceiverView | null;

  static base(r: VisitRead, me: string): ResidentVisitBase {
    const v = r.visit;
    const granter = v.consentById ? first(r, v.consentById) : null;
    return {
      id: v.id,
      status: v.status,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      proposedBySide: v.proposedBySide,
      technician: first(r, v.technicianId),
      absenceEntry: {
        approved: v.absenceEntryApproved,
        grantedBy: granter ? { ...granter, mine: v.consentById === me } : null,
        grantedAt: v.consentAt,
      },
      receiver: r.receiver
        ? {
            kind: r.receiver.kind,
            id: r.receiver.id,
            firstName: firstNameOf(r.receiver.fullName),
          }
        : null,
    };
  }
}

/** A ticket's visit, for its residents (`/tickets/:id/visits`). */
export class ResidentVisitView extends ResidentVisitBase {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  previousVisitId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  arrivedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReasonCode: string | null;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide', nullable: true })
  cancelledBySide: VisitSide | null;

  static from(r: VisitRead, me: string): ResidentVisitView {
    const v = r.visit;
    return {
      ...ResidentVisitBase.base(r, me),
      previousVisitId: v.previousVisitId,
      confirmedAt: v.confirmedAt,
      arrivedAt: v.arrivedAt,
      finishedAt: v.finishedAt,
      cancelledAt: v.cancelledAt,
      cancelReasonCode: v.cancelReasonCode,
      cancelledBySide: v.cancelledBySide,
    };
  }
}

/** An active visit of a unit, for an adult who lives there. */
export class UnitVisitView extends ResidentVisitBase {
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  ticketNumber: string;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' })
  ticketStatus: TicketStatus;
  @ApiProperty({ type: TicketCategoryRefView })
  category: TicketCategoryRefView;

  static from(r: UnitVisitRead, me: string): UnitVisitView {
    return {
      ...ResidentVisitBase.base(r, me),
      ticketId: r.ticket.id,
      ticketNumber: ticketNumber(r.ticket.number),
      ticketStatus: r.ticket.status,
      category: TicketCategoryRefView.from(r.category),
    };
  }
}

/** Who receives the technician: a first name and a kind, nothing else. */
export class TechnicianReceiverView {
  @ApiProperty({ enum: VisitReceiverKind, enumName: 'VisitReceiverKind' })
  kind: VisitReceiverKind;
  @ApiProperty({ type: String, nullable: true })
  firstName: string | null;
}

/** The technician's own visit. */
export class TechnicianVisitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: VisitStatus, enumName: 'VisitStatus' })
  status: VisitStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide' })
  proposedBySide: VisitSide;
  @ApiProperty({
    type: Boolean,
    description:
      'Someone who lives there allowed entry while nobody is home, for this visit. False: do not enter unless let in.',
  })
  absenceEntryApproved: boolean;
  @ApiProperty({ type: TechnicianReceiverView, nullable: true })
  receiver: TechnicianReceiverView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  arrivedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReasonCode: string | null;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide', nullable: true })
  cancelledBySide: VisitSide | null;

  static from(r: VisitRead): TechnicianVisitView {
    const v = r.visit;
    return {
      id: v.id,
      status: v.status,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      proposedBySide: v.proposedBySide,
      absenceEntryApproved: v.absenceEntryApproved,
      receiver: r.receiver
        ? {
            kind: r.receiver.kind,
            firstName: firstNameOf(r.receiver.fullName),
          }
        : null,
      arrivedAt: v.arrivedAt,
      finishedAt: v.finishedAt,
      cancelledAt: v.cancelledAt,
      cancelReasonCode: v.cancelReasonCode,
      cancelledBySide: v.cancelledBySide,
    };
  }
}

export class DispatchAbsenceEntryView {
  @ApiProperty({ type: Boolean })
  approved: boolean;
  @ApiProperty({ type: AccountRefView, nullable: true })
  grantedBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  grantedAt: Date | null;
}

export class DispatchReceiverView {
  @ApiProperty({ enum: VisitReceiverKind, enumName: 'VisitReceiverKind' })
  kind: VisitReceiverKind;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}

/** Every visit of the compound, for dispatch: full names, no contact data. */
export class DispatchVisitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: VisitStatus, enumName: 'VisitStatus' })
  status: VisitStatus;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: AccountRefView })
  technician: AccountRefView;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide' })
  proposedBySide: VisitSide;
  @ApiProperty({ type: AccountRefView })
  proposedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  previousVisitId: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  confirmedBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: Date | null;
  @ApiProperty({ type: DispatchAbsenceEntryView })
  absenceEntry: DispatchAbsenceEntryView;
  @ApiProperty({ type: DispatchReceiverView, nullable: true })
  receiver: DispatchReceiverView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  arrivedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReasonCode: string | null;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide', nullable: true })
  cancelledBySide: VisitSide | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null for the system.',
  })
  cancelledBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lateNotifiedAt: Date | null;

  static from(r: VisitRead): DispatchVisitView {
    const v = r.visit;
    return {
      id: v.id,
      status: v.status,
      cycle: v.cycle,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      technician: full(r, v.technicianId)!,
      proposedBySide: v.proposedBySide,
      proposedBy: full(r, v.proposedById)!,
      previousVisitId: v.previousVisitId,
      confirmedBy: full(r, v.confirmedById),
      confirmedAt: v.confirmedAt,
      absenceEntry: {
        approved: v.absenceEntryApproved,
        grantedBy: full(r, v.consentById),
        grantedAt: v.consentAt,
      },
      receiver: r.receiver
        ? {
            kind: r.receiver.kind,
            id: r.receiver.id,
            fullName: r.receiver.fullName,
          }
        : null,
      arrivedAt: v.arrivedAt,
      finishedAt: v.finishedAt,
      cancelledAt: v.cancelledAt,
      cancelReasonCode: v.cancelReasonCode,
      cancelledBySide: v.cancelledBySide,
      cancelledBy: full(r, v.cancelledById),
      lateNotifiedAt: v.lateNotifiedAt,
    };
  }
}

/** One event of a visit's history: dispatch only, never the window. */
export class VisitEventView {
  @ApiProperty({ type: String, format: 'uuid' })
  visitId: string;
  @ApiProperty({ enum: VisitEventKind, enumName: 'VisitEventKind' })
  kind: VisitEventKind;
  @ApiProperty({ enum: VisitSide, enumName: 'VisitSide' })
  actorSide: VisitSide;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null for the system.',
  })
  actor: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static list(h: {
    rows: {
      visitId: string;
      kind: VisitEventKind;
      actorSide: VisitSide;
      actorId: string | null;
      reasonCode: string | null;
      at: Date;
    }[];
    people: Map<string, Person>;
  }): VisitEventView[] {
    return h.rows.map((e) => ({
      visitId: e.visitId,
      kind: e.kind,
      actorSide: e.actorSide,
      actor: e.actorId
        ? h.people.has(e.actorId)
          ? accountRef(h.people.get(e.actorId)!)
          : erased(e.actorId)
        : null,
      reasonCode: e.reasonCode,
      at: e.at,
    }));
  }
}

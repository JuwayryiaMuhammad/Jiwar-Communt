import { ApiProperty } from '@nestjs/swagger';
import type { TechnicianHelpRequest } from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';

export const HELP_KINDS = [
  'extra_hands',
  'expertise',
  'parts',
  'safety',
] as const;
export const HELP_STATUSES = [
  'open',
  'taken',
  'resolved',
  'cancelled',
] as const;

export interface HelpNames {
  people: Map<string, { id: string; fullName: string | null; status: string }>;
  /** A ticket's id to its number, `T-…`. */
  tickets: Map<string, string>;
}

/** A ticket a call is about: its id and number. */
export class HelpTicketView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'T-000123' })
  number: string;
}

/**
 * A technician's call for help (ADR 0078), as the caller, the helper and
 * the field team read it.
 */
export class HelpRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: HELP_KINDS, enumName: 'TechnicianHelpKind' })
  kind: string;
  @ApiProperty({
    enum: HELP_STATUSES,
    enumName: 'TechnicianHelpStatus',
    description:
      '`open` until the field team takes it, `taken` (with a helper or none), then `resolved`; `cancelled` when the caller calls it off.',
  })
  status: string;
  @ApiProperty({
    type: AccountRefView,
    description: 'The technician who called.',
  })
  requester: AccountRefView;
  @ApiProperty({ type: HelpTicketView, nullable: true })
  ticket: HelpTicketView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The caller’s own words, staff-only.',
  })
  note: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  takenBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  takenAt: Date | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'The technician sent to help, if any.',
  })
  helper: AccountRefView | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the managers were told nobody had taken it.',
  })
  escalatedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: TechnicianHelpRequest, names: HelpNames): HelpRequestView {
    const ref = (id: string | null) =>
      id ? accountRef(names.people.get(id)!) : null;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      requester: accountRef(names.people.get(r.requesterId)!),
      ticket: r.ticketId
        ? { id: r.ticketId, number: names.tickets.get(r.ticketId) ?? '' }
        : null,
      note: r.note,
      takenBy: ref(r.takenById),
      takenAt: r.takenAt,
      helper: ref(r.helperId),
      escalatedAt: r.escalatedAt,
      resolvedAt: r.resolvedAt,
      cancelledAt: r.cancelledAt,
      createdAt: r.createdAt,
    };
  }
}

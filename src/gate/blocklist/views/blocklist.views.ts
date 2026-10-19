import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type { BlocklistRecord, MatchRecord } from '../blocklist.service';

const KINDS = ['ban', 'watch'] as const;

export class BlocklistGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
}
const SUBJECTS = ['plate', 'person'] as const;
const STATUSES = ['active', 'expired', 'lifted'] as const;

/**
 * An entry as a guard on shift reads it (ADR 0053): what to look for — a
 * plate, or a name and a face — and whether to refuse or to watch. Never
 * why, never the management's note, never an ID number.
 */
export class GuardBlocklistEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: KINDS, enumName: 'BlocklistKind' })
  kind: string;
  @ApiProperty({ enum: SUBJECTS, enumName: 'BlocklistSubject' })
  subject: string;
  @ApiProperty({ type: String, nullable: true })
  plate: string | null;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description: 'The face, a presigned URL.',
  })
  photo: PresignedReadView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  since: Date;

  static from(r: BlocklistRecord): GuardBlocklistEntryView {
    const e = r.entry;
    return {
      id: e.id,
      kind: e.kind,
      subject: e.subject,
      plate: e.plate,
      fullName: e.fullName,
      photo: r.photo,
      since: e.createdAt,
    };
  }
}

/** An entry as the management keeps it (`blocklist.manage`). */
export class StaffBlocklistEntryView extends GuardBlocklistEntryView {
  @ApiProperty({ enum: STATUSES, enumName: 'BlocklistStatus' })
  status: string;
  @ApiProperty({
    type: Boolean,
    description:
      'A person: whether their ID number is on file (its hash; never shown). False once purged.',
  })
  hasIdNumber: boolean;
  @ApiProperty({
    enum: [...REASON_CODES.blocklistReason],
    enumName: 'BlocklistReason',
  })
  reasonCode: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;
  @ApiProperty({ type: AccountRefView })
  createdBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  liftedAt: Date | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null when the system lifted it (expired).',
  })
  liftedBy: AccountRefView | null;
  @ApiProperty({
    enum: [...REASON_CODES.blocklistLift, ...REASON_CODES.blocklistLiftSystem],
    enumName: 'BlocklistLift',
    nullable: true,
  })
  liftReason: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the person’s name, ID hash, face and note went.',
  })
  purgedAt: Date | null;

  static from(r: BlocklistRecord): StaffBlocklistEntryView {
    const e = r.entry;
    return {
      ...GuardBlocklistEntryView.from(r),
      status: r.status,
      hasIdNumber: e.idHash !== null,
      reasonCode: e.reasonCode,
      note: e.note,
      expiresAt: e.expiresAt,
      createdBy: accountRef(r.createdBy),
      liftedAt: e.liftedAt,
      liftedBy: r.liftedBy && accountRef(r.liftedBy),
      liftReason: e.liftReason,
      purgedAt: e.purgedAt,
    };
  }
}

/** What the guard's ID lookup answers (ADR 0053). */
export class IdLookupView {
  @ApiProperty({
    type: [GuardBlocklistEntryView],
    description: 'The person’s live entries; empty for none.',
  })
  matches: GuardBlocklistEntryView[];
}

/** Where the gate met an entry (ADR 0053), for its keepers. */
export class BlocklistMatchView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: KINDS,
    enumName: 'BlocklistKind',
    description: 'The entry’s kind when it was met.',
  })
  kind: string;
  @ApiProperty({
    enum: [
      'visitor_pass',
      'move_permit',
      'event_guest',
      'gate_request',
      'verify',
      'entry',
      'plate_lookup',
      'id_lookup',
      'field_exception',
    ],
    enumName: 'BlocklistMatchSource',
    description:
      'Where: a pass, a move or a guest recorded by a resident; a gate request, a verify or an entry at the gate; a guard’s plate or ID lookup; a field exception the guard raised (ADR 0056).',
  })
  source: string;
  @ApiProperty({
    enum: ['refused', 'flagged', 'noted'],
    enumName: 'BlocklistMatchOutcome',
    description:
      '`refused`: kept out; `flagged`: let in and watched; `noted`: met on a record or a lookup.',
  })
  outcome: string;
  @ApiProperty({
    enum: [
      'visitor_pass',
      'gate_request',
      'event_guest',
      'move_permit',
      'field_exception',
    ],
    nullable: true,
  })
  subjectType: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  subjectId: string | null;
  @ApiProperty({ type: BlocklistGateView, nullable: true })
  gate: BlocklistGateView | null;
  @ApiProperty({
    type: AccountRefView,
    description: 'Who recorded or looked it up.',
  })
  actor: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(r: MatchRecord): BlocklistMatchView {
    const m = r.match;
    return {
      id: m.id,
      kind: m.kind,
      source: m.source,
      outcome: m.outcome,
      subjectType: m.subjectType,
      subjectId: m.subjectId,
      gate: r.gate && { ...r.gate },
      actor: accountRef(r.actor),
      at: m.createdAt,
    };
  }
}

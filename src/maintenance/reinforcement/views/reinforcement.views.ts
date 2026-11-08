import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { CALL_STATUSES, SUGGESTION_STATUSES } from '../dto/reinforcement.dto';
import type { CallRead, SuggestionRead } from '../reinforcement.service';

const ANSWERS = ['accepted', 'declined'] as const;

/** Service pressure's rise, offered to the field team (ADR 0090). */
export class ReinforcementSuggestionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: SUGGESTION_STATUSES,
    enumName: 'ReinforcementSuggestionStatus',
    description:
      '`open` until a call answers it, it is dismissed, or the pressure eases (`lapsed`).',
  })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  raisedAt: string;
  @ApiProperty({ type: Number, description: 'Open tickets when told.' })
  openTickets: number;
  @ApiProperty({ type: Number, description: 'Available technicians then.' })
  available: number;
  @ApiProperty({ type: Number, description: 'Open tickets per technician.' })
  threshold: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  callId: string | null;

  static from(r: SuggestionRead): ReinforcementSuggestionView {
    const s = r.suggestion;
    return {
      id: s.id,
      status: s.status,
      raisedAt: s.raisedAt.toISOString(),
      openTickets: s.openTickets,
      available: s.available,
      threshold: s.threshold,
      createdAt: s.createdAt.toISOString(),
      decidedAt: s.decidedAt?.toISOString() ?? null,
      decidedBy: r.decidedBy ? accountRef(r.decidedBy) : null,
      reasonCode: s.reasonCode,
      callId: s.callId,
    };
  }
}

export class ReinforcementZoneView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

/** Whom a call reached, and their answer. */
export class ReinforcementRecipientView {
  @ApiProperty({ type: AccountRefView })
  technician: AccountRefView;
  @ApiProperty({
    enum: ANSWERS,
    enumName: 'ReinforcementAnswer',
    nullable: true,
  })
  answer: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  answeredAt: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The roster slot an acceptance wrote.',
  })
  slotId: string | null;
}

/** A reinforcement call (ADR 0090). */
export class ReinforcementCallView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: CALL_STATUSES,
    enumName: 'ReinforcementCallStatus',
    description:
      '`open` until as many accept (`filled`), its start (`closed`) or it is called off (`cancelled`).',
  })
  status: string;
  @ApiProperty({ type: Number })
  needed: number;
  @ApiProperty({ type: Number })
  accepted: number;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: string;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: string;
  @ApiProperty({
    type: ReinforcementZoneView,
    nullable: true,
    description: 'Null: the whole compound.',
  })
  zone: ReinforcementZoneView | null;
  @ApiProperty({ type: AccountRefView })
  sentBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  sentAt: string;
  @ApiProperty({ type: Number, description: 'Technicians it reached.' })
  recipientCount: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: string | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  suggestionId: string | null;
  @ApiProperty({
    type: [ReinforcementRecipientView],
    nullable: true,
    description:
      'The field team’s single read: whom it reached and their answers. Null in lists and for a technician.',
  })
  recipients: ReinforcementRecipientView[] | null;
  @ApiProperty({
    enum: ANSWERS,
    enumName: 'ReinforcementAnswer',
    nullable: true,
    description: 'A technician’s read: their own answer, or null.',
  })
  myAnswer: string | null;

  static from(r: CallRead): ReinforcementCallView {
    const c = r.call;
    return {
      id: c.id,
      status: c.status,
      needed: c.needed,
      accepted: c.accepted,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      zone: r.zone,
      sentBy: accountRef(r.sentBy),
      sentAt: c.sentAt.toISOString(),
      recipientCount: c.recipients,
      closedAt: c.closedAt?.toISOString() ?? null,
      cancelReason: c.cancelReason,
      suggestionId: c.suggestionId,
      recipients: r.recipients
        ? r.recipients.map((x) => ({
            technician: accountRef(x.person),
            answer: x.answer,
            answeredAt: x.answeredAt?.toISOString() ?? null,
            slotId: x.slotId,
          }))
        : null,
      myAnswer: r.mine?.answer ?? null,
    };
  }
}

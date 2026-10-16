import { ApiProperty } from '@nestjs/swagger';
import type { GuardRosterSlot, GuardShiftSwap } from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';

/** What the swap views read beside the rows. */
export interface SwapContext {
  names: DutyNames;
  slots: Map<string, GuardRosterSlot>;
  me: string;
}

/** A slot as a swap names it: where and when. */
export class SwapSlotView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static of(slot: GuardRosterSlot, c: SwapContext): SwapSlotView {
    return {
      id: slot.id,
      post: PostView.of(slot, c.names),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    };
  }
}

const STATUS = {
  enum: [
    'requested',
    'accepted',
    'approved',
    'declined',
    'rejected',
    'withdrawn',
    'cancelled',
    'expired',
  ],
  enumName: 'GuardSwapStatus',
};

class GuardSwapBodyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty(STATUS)
  status: string;
  @ApiProperty({ type: SwapSlotView, description: 'The requester’s.' })
  requesterSlot: SwapSlotView;
  @ApiProperty({
    type: SwapSlotView,
    nullable: true,
    description: 'The colleague’s, in exchange; null for a cover.',
  })
  colleagueSlot: SwapSlotView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The requester’s.',
  })
  reason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.guardSwapReject],
    enumName: 'GuardSwapReject',
    nullable: true,
  })
  rejectReason: string | null;
  @ApiProperty({
    enum: [...REASON_CODES.guardSwapCancel],
    enumName: 'GuardSwapCancel',
    nullable: true,
    description: 'Why the system cancelled it.',
  })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

function body(s: GuardShiftSwap, c: SwapContext): GuardSwapBodyView {
  const theirs = s.colleagueSlotId ? c.slots.get(s.colleagueSlotId) : null;
  return {
    id: s.id,
    status: s.status,
    requesterSlot: SwapSlotView.of(c.slots.get(s.requesterSlotId)!, c),
    colleagueSlot: theirs ? SwapSlotView.of(theirs, c) : null,
    reason: s.reason,
    acceptedAt: s.acceptedAt,
    decidedAt: s.decidedAt,
    rejectReason: s.rejectReason,
    closeReason: s.closeReason,
    createdAt: s.createdAt,
  };
}

/** A swap as its guards read it: each other by first name. */
export class GuardSwapView extends GuardSwapBodyView {
  @ApiProperty({ type: FirstNameRefView })
  requester: FirstNameRefView;
  @ApiProperty({ type: FirstNameRefView })
  colleague: FirstNameRefView;
  @ApiProperty({
    enum: ['requester', 'colleague'],
    description: 'What I am in it.',
  })
  role: 'requester' | 'colleague';

  static from(s: GuardShiftSwap, c: SwapContext): GuardSwapView {
    return {
      ...body(s, c),
      requester: firstNameRef(c.names.people.get(s.requesterId)!),
      colleague: firstNameRef(c.names.people.get(s.colleagueId)!),
      role: s.requesterId === c.me ? 'requester' : 'colleague',
    };
  }
}

/** A swap as the roster's keepers read it: full names, who decided. */
export class StaffGuardSwapView extends GuardSwapBodyView {
  @ApiProperty({ type: AccountRefView })
  requester: AccountRefView;
  @ApiProperty({ type: AccountRefView })
  colleague: AccountRefView;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;

  static of(s: GuardShiftSwap, c: SwapContext): StaffGuardSwapView {
    const by = s.decidedById ? c.names.people.get(s.decidedById) : undefined;
    return {
      ...body(s, c),
      requester: accountRef(c.names.people.get(s.requesterId)!),
      colleague: accountRef(c.names.people.get(s.colleagueId)!),
      decidedBy: by ? accountRef(by) : null,
    };
  }
}

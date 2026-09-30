import { ApiProperty } from '@nestjs/swagger';
import { HouseholdMemberStatus } from '@prisma/client';
import type { AcceptedInvite } from '../households.types';

/** The only answer to a start, whatever the token (ADR 0016). */
export class InviteCodeRequestedView {
  @ApiProperty({ enum: ['INVITE_CODE_REQUESTED'] })
  code: 'INVITE_CODE_REQUESTED';
}

export const INVITE_CODE_REQUESTED: InviteCodeRequestedView = {
  code: 'INVITE_CODE_REQUESTED',
};

/**
 * The invitee proved the email: the account exists now and they log in
 * through the normal OTP login. No ids: nothing here is needed to log in.
 */
export class InviteAcceptedView {
  @ApiProperty({ enum: ['INVITE_ACCEPTED'] })
  code: 'INVITE_ACCEPTED';
  @ApiProperty({
    enum: HouseholdMemberStatus,
    enumName: 'HouseholdMemberStatus',
    description:
      '`pending_approval` when the compound approves new members first.',
  })
  membershipStatus: HouseholdMemberStatus;

  static from(a: AcceptedInvite): InviteAcceptedView {
    return { code: 'INVITE_ACCEPTED', membershipStatus: a.membershipStatus };
  }
}

/** A household's members and a unit's occupants (ADR 0012, 0020, 0021): components/units/household-overrides, occupant-actions. */
export default {
  // Management's decisions on a household member.
  thisMember: 'this member',
  removed: '{name} is removed from the household.',
  revoked: 'Taken back from {name}.',
  holdsNothing: '{name} holds no permission in this household.',
  revokeAccess: 'Revoke access',
  removeTitle: 'Remove {name} from the household?',
  removeDescription:
    'They lose their place in this unit’s household and everything it gave them. They are told, with your message. The primary resident can invite them again.',
  removeConfirm: 'Remove member',
  revokeTitle: 'Take back access from {name}?',
  revokeKnown: 'They keep their place in the household and lose what you pick, from what they hold now. They are told, with your message.',
  revokeUnknown:
    'They keep their place in the household and lose what you pick. They are told, with your message. Your role does not show what they hold, so a permission they do not hold is simply refused.',
  revokeConfirm: 'Revoke',
  whatToTakeBack: 'What to take back',
  'perm.visitors_invite': 'Invite visitors',
  'perm.bookings': 'Bookings',
  'perm.tickets': 'Maintenance tickets',
  'perm.finance': 'Payments',
  'perm.unit_security': 'Unit security',
  'perm.polls_vote': 'Voting in polls',
  'perm.all': 'Everything they were given',
  // How an occupant holds the unit.
  thisResident: 'This resident',
  nowOwnsToast: '{name} now owns the unit.',
  livesInToast: '{name} lives in the unit.',
  landlordToast: '{name} is now a landlord: an owner who lives elsewhere.',
  nowOwns: 'Now owns it',
  movedOut: 'Moved out',
  movedIn: 'Moved in',
  convertTitle: '{name} bought the unit?',
  convertDescription:
    'Their tenant occupancy ends and an owner occupancy starts in its place, keeping the primary role if they had it. They are told, and the owner’s decisions open to them.',
  makeOwner: 'Make owner',
  livesThere: 'They live in the unit',
  moveOutTitle: '{name} moved out of the unit?',
  moveInTitle: '{name} moved into the unit?',
  moveOutDescription:
    'They stay the owner, as a landlord: they no longer see the household that lives there. A primary resident must live in the unit, so name another primary first.',
  moveInDescription: 'They become an owner who lives in the unit, and can be named its primary resident.',
  recordMoveOut: 'Record move out',
  recordMoveIn: 'Record move in',
} as const;

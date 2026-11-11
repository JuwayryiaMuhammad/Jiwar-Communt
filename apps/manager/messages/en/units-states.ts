/** A unit's review flags and who holds it (ADR 0021, 0083): components/units/unit-states. */
export default {
  'help.primary_left':
    'The primary resident left. Name a new primary among the occupants if the family stays, or end the household. It cannot be cleared by hand.',
  'help.primary_frozen': 'The primary resident’s account is frozen. It clears when the account is reactivated or a new primary is named.',
  'help.primary_deceased':
    'Household grants and revocations are frozen and payments stopped; tickets, visitors and emergency continue. Name a new primary, or clear the flag if it was recorded by mistake.',
  'help.separation':
    'Removing an adult or revoking an adult’s access is your decision now, from the household table. Clear the flag once it is settled.',
  recordedDeceased: 'Recorded. The household is under review and the adults are told so, never why.',
  separationRecorded: 'Separation recorded. Removing an adult is now your decision.',
  householdEnded: 'Household ended. Its members, delegations and worker engagements have ended.',
  transferRequested: 'Transfer requested. Approve it on the Transfers page once the dues are checked.',
  flagCleared: 'Review flag cleared.',
  noteHint: 'Kept with the flag for management. Never shown to the household and never in the audit trail.',
  underReview: 'Under review',
  since: 'since {date}',
  clear: 'Clear',
  whoHolds: 'Who holds the unit',
  whoHoldsHint: 'For when something changed that the residents cannot settle themselves.',
  primaryDied: 'Primary has died',
  separation: 'Separation',
  transferOwnership: 'Transfer ownership',
  endHousehold: 'End household',
  deceasedTitle: 'Record that unit {code}’s primary resident has died?',
  deceasedDescription:
    'Nothing is closed or revoked. The household’s permissions freeze and payments stop until a new primary is named; tickets, visitors and emergency continue. The adults are told the unit is under review, never why.',
  noteForRecord: 'Note for the record',
  record: 'Record',
  separationTitle: 'Record a separation in unit {code}?',
  separationDescription:
    'Removing an adult or revoking an adult’s access becomes your decision, and the household’s shared activity view stops. Entry, tickets, emergency and visitor notices continue for everyone. The adults are told.',
  endTitle: 'End the household of unit {code}?',
  endDescription:
    'Every membership, pending invite, delegation and domestic worker engagement of the unit ends, and each person is told. The occupancies stay: end those separately if the occupants left. This cannot be undone; a new household starts from invitations.',
  transferTitle: 'Request the transfer of unit {code}?',
  transferDescription:
    'It waits on the Transfers page and in the inbox. When it is approved, every current occupancy of the unit ends and the household ends with it, including every domestic worker engagement of the household; each person is told. A unit that owes the compound is not transferred unless the approval is an exception with a reason.',
  transferConfirm: 'Request the transfer',
  pickOwnerFirst: 'Pick the new owner first.',
  newOwner: 'New owner',
  newOwnerHint: 'A resident of the compound: type part of the name, or the exact phone or email. Add them on the Residents page first if they are new.',
  selectResident: 'Select a resident…',
  livesHereNow: '{name} (lives here now)',
  newOwnerLives: 'The new owner will live in the unit (they become its primary resident)',
  clearTitle: 'Clear “{reason}”?',
  clearDescription: 'The household works normally again where this flag held it back.',
  clearConfirm: 'Clear flag',
} as const;

/** The owners' agenda proposals, the board's side (ADR 0059): app/(dashboard)/board/agenda. */
export default {
  title: 'Agenda proposals',
  description:
    'Matters the owners asked the board to take up. A sitting member accepts or declines each, once; accepting binds the board to nothing.',
  'view.open': 'To answer',
  'view.accepted': 'Accepted',
  'view.declined': 'Declined',
  'view.withdrawn': 'Withdrawn',
  nothing: 'Nothing here',
  'col.proposal': 'Proposal',
  'col.proposed': 'Proposed',
  titleErased: 'Removed: its proposer’s account was erased',
  // One proposal.
  proposal: 'Proposal',
  accept: 'Accept',
  decline: 'Decline',
  proposed: 'Proposed',
  theProposal: 'The proposal',
  bodyErased: 'Removed: its proposer’s account was erased.',
  answered: 'Answered',
  boardNote: 'The board’s note',
  withdrawn: 'Withdrawn',
  // Answering.
  acceptedToast: 'Accepted. The proposer was told.',
  declinedToast: 'Declined. The proposer was told.',
  acceptTitle: 'Accept this proposal?',
  declineTitle: 'Decline this proposal?',
  decideDescription: 'Once, for the board. The proposer reads your note: write no one’s name in it.',
  why: 'Why',
  chooseReason: 'Choose a reason',
  note: 'Note to the proposer (optional)',
} as const;

/** The owners' objections to the board's decisions (ADR 0059): app/(dashboard)/board/objections. */
export default {
  title: 'Objections',
  description:
    'Owners may object to a decision of the board within the compound’s objection days. The board answers once, with its reasons, to every objector; then the decision takes no more.',
  empty: 'No decision takes objections',
  'col.decision': 'Decision',
  'col.decidedOn': 'Decided on',
  'col.until': 'Objections until',
  'col.state': 'State',
  aDecision: 'A decision',
  'state.open': 'Taking objections',
  'state.closed': 'Its days have passed',
  'state.answered': 'Answered',
  // One decision's objections.
  ofDecision: 'Objections to a decision',
  answer: 'Answer',
  count: 'Objections',
  takenUntil: 'Taken until',
  boardAnswer: 'The board’s answer',
  grounds: 'Their grounds',
  noObjection: 'No objection',
  'col.grounds': 'Grounds',
  'col.lodged': 'Lodged',
  groundsErased: 'Removed: its owner’s account was erased.',
  // Answering.
  answered: 'Answered. Every objector was told; the decision takes no more objections.',
  answerTitle: 'Answer the objections',
  answerDescription:
    'Once, for the board: every objector reads it, and the decision takes no more objections after. Write no one’s name.',
} as const;

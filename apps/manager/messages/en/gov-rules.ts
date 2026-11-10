/** The compound's governance rules (ADR 0075): app/(dashboard)/governance/rules. */
export default {
  title: 'Board rules',
  description: 'Checked by the system; the rest of a candidate’s eligibility is yours, by disqualification with a code.',
  candidacies: 'Candidacies',
  noDues: 'Refuse an owner whose units owe past their due date',
  notStaff: 'Refuse an owner who also holds an active staff or manager account',
  documents: 'The board’s documents',
  monthly: 'Send the board last month’s report on a month’s first days',
  hasLogo: 'A logo heads the board’s documents.',
  noLogo: 'No logo yet.',
  replaceLogo: 'Replace the logo',
  addLogo: 'Add a logo',
  removeLogo: 'Take the logo off',
} as const;

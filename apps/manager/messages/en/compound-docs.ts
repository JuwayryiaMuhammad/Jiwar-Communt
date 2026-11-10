/** The compound's documents (ADR 0062): app/(dashboard)/compound-documents. */
export default {
  title: 'Compound documents',
  description:
    'What residents read in the app: the bylaws, their rights, the code of conduct and the moving guide. Each new version keeps the ones before.',
  'kind.bylaws': 'Bylaws',
  'kind.occupant_rights': 'Your rights',
  'kind.conduct_guide': 'Code of conduct',
  'kind.moving_guide': 'Moving guide',
  'kind.saving_tips': 'Saving tips',
  'kind.emergency_medical': 'Emergency: medical',
  'kind.emergency_fire': 'Emergency: fire',
  'kind.emergency_security': 'Emergency: security',
  'kind.emergency_facilities': 'Emergency: facilities',
  'hint.bylaws': 'Adopted by the board: cite its published decision.',
  'hint.occupant_rights': 'What an occupant may rely on, in plain words.',
  'hint.conduct_guide': 'How neighbours live together.',
  'hint.moving_guide': 'Renewing a lease or moving out: what each means, the dates, the fees.',
  'hint.saving_tips': 'How a household uses less water, power and gas.',
  'hint.emergency_medical': 'What to do in a medical emergency, and whom to call.',
  'hint.emergency_fire': 'What to do in a fire: the way out, the assembly point.',
  'hint.emergency_security': 'What to do when security is threatened.',
  'hint.emergency_facilities': 'A gas leak, a flood, a power failure: what to shut and whom to call.',
  rightsTemplate: `## Your home
- You may live in your unit and use the common areas the compound opens to residents.
- Nobody enters your unit without you, except in an emergency.

## Your requests
- You may ask the management anything, and get an answer within the time it publishes.
- You may appeal a decision about your unit, first to the management, then to the board.

## Your money
- You see every invoice of your unit and every payment, and you may dispute an invoice.
- A deposit the management holds is yours; you may ask for it back when you leave.`,
  document: 'Document',
  published: 'Published',
  versionLine: 'Version {no} · in force {date}',
  notPublished: 'Not published yet',
  publishAmendment: 'Publish an amendment',
  publish: 'Publish',
  publishTitle: 'Publish: {kind}',
  amendTitle: 'Amend: {kind}',
  publishedToast: 'Published.',
  titleEn: 'Title (English)',
  titleAr: 'Title (Arabic)',
  textEn: 'Text (English)',
  textAr: 'Text (Arabic)',
  markdown: 'Markdown.',
  changesEn: 'What it changes (English)',
  changesAr: 'What it changes (Arabic)',
  inForceFrom: 'In force from',
  boardDecision: 'The board’s decision',
  boardDecisionHint: 'The id of the decision the board published (Board → Publications).',
  fileAttached: 'Signed PDF attached — replace',
  attachFile: 'Attach the signed PDF (optional)',
} as const;

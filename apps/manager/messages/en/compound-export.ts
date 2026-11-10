/** The compound's export (ADR 0086): app/(dashboard)/compound-export. */
export default {
  title: 'Compound export',
  description:
    'The compound’s operational data as one archive of fixed tables. No one’s name, phone, email or words; a person’s own data leaves only through their own export.',
  export: 'Export the compound',
  asked: 'Asked for. You are told in the app when it is ready.',
  empty: 'No export yet',
  askedOn: 'Asked',
  rows: 'Rows',
  confirmTitle: 'Confirm it is you',
  confirmDescription:
    'The whole compound’s data leaves with this export: it is prepared only after a fresh code sent to your email.',
} as const;

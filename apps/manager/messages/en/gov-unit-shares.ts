/** The units' ownership shares (ADR 0075): app/(dashboard)/governance/unit-shares. */
export default {
  title: 'Ownership shares',
  saved: 'Saved. A poll already open keeps the shares it took.',
  weighted: 'For polls weighted by share.',
  recorded:
    'For polls weighted by share. Recorded: {total} in all; {missing, plural, one {# owned unit has none and weighs 0} other {# owned units have none and weigh 0}}.',
  none: 'No owned unit yet',
  'col.unit': 'Unit',
  'col.share': 'Share (%)',
  shareAria: 'Share of {unit}',
  placeholder: 'None',
} as const;

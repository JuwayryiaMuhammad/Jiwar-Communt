/** An asset's economics and contracts (ADR 0065): components/operations/asset-economics.tsx. */
export default {
  economics: 'Economics',
  advice: 'Advice',
  adviceWith: '{advice} — {reasons}',
  spent: 'Spent, ever',
  spentSplit: '{total} (corrective {corrective}, planned {planned})',
  lastYear: 'Last twelve months',
  failures: 'Failures',
  mtbf: 'Mean days between failures',
  downtime: 'Downtime',
  downtimeDays: '{n, plural, one {# day} other {# days}}',
  downtimeWithCost: '{n, plural, one {# day} other {# days}} · {cost}',
  replacementDue: 'Replacement due',
  reserve: 'Reserve',
  reserveText: '{annual} a year · {accrued} built up',
  underContract: 'Under contract',
  until: 'until {day}',
} as const;

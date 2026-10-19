import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

/** What a budget line is for (ADR 0055); one line per category. */
export const BUDGET_CATEGORIES = [
  'security',
  'cleaning',
  'landscaping',
  'maintenance',
  'utilities',
  'staff',
  'insurance',
  'administration',
  'reserve_fund',
  'other',
] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

/** As the board's announcement names them. */
export const CATEGORY_LABELS: Record<
  BudgetCategory,
  { en: string; ar: string }
> = {
  security: { en: 'Security', ar: 'الأمن' },
  cleaning: { en: 'Cleaning', ar: 'النظافة' },
  landscaping: { en: 'Landscaping', ar: 'الحدائق' },
  maintenance: { en: 'Maintenance', ar: 'الصيانة' },
  utilities: { en: 'Utilities', ar: 'المرافق' },
  staff: { en: 'Staff', ar: 'العاملون' },
  insurance: { en: 'Insurance', ar: 'التأمين' },
  administration: { en: 'Administration', ar: 'الإدارة' },
  reserve_fund: { en: 'Reserve fund', ar: 'الاحتياطي' },
  other: { en: 'Other', ar: 'أخرى' },
};

export const BUDGET_STATUSES = [
  'draft',
  'submitted',
  'active',
  'rejected',
  'withdrawn',
] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

export const BUDGET_LIMITS = {
  lines: BUDGET_CATEGORIES.length,
  note: 200,
  vendor: 200,
  reference: 100,
} as const;

/**
 * A fiscal year's days: from the first of its start month in the year it
 * is named after, to the day before the same date a year on.
 */
export function fiscalWindow(
  year: number,
  startMonth: number,
): { startsOn: LocalDate; endsOn: LocalDate } {
  const mm = String(startMonth).padStart(2, '0');
  return {
    startsOn: `${year}-${mm}-01`,
    endsOn: addDays(`${year + 1}-${mm}-01`, -1),
  };
}

/** The fiscal year a local day falls in. */
export function fiscalYearOf(day: LocalDate, startMonth: number): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month >= startMonth ? year : year - 1;
}

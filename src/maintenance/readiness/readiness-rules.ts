import { Prisma } from '@prisma/client';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { addDays, daysBetween, type LocalDate } from '../schedules/local-dates';

/** What a program prepares for (ADR 0067); the migration's CHECK repeats it. */
export const READINESS_KINDS = ['season', 'event', 'emergency'] as const;
export type ReadinessKind = (typeof READINESS_KINDS)[number];

/** What an item is; the migration's CHECK repeats it. */
export const READINESS_ITEM_KINDS = [
  'task',
  'inspection_campaign',
  'contract_review',
  'estimate',
] as const;
export type ReadinessItemKind = (typeof READINESS_ITEM_KINDS)[number];

/** A program's days: at most a year and a day, as the CHECK says. */
export const MAX_PROGRAM_DAYS = 366;
export const TITLE_MAX = 120;
/** EGP, two places at most, more than 0: DECIMAL(12,2) in the database. */
export const ESTIMATE = /^\d{1,10}(\.\d{1,2})?$/;

/** A title, once trimmed: 1 to 120 characters, as the CHECK says. */
export const titleProblems = (title: string): FieldError[] =>
  title.length >= 1 && title.length <= TITLE_MAX
    ? []
    : [
        {
          field: 'title',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 1, max: TITLE_MAX },
        },
      ];

/** A program's window: the end on or after the start, a year and a day at most. */
export function windowProblems(
  startsOn: LocalDate,
  endsOn: LocalDate,
): FieldError[] {
  if (endsOn < startsOn)
    return [{ field: 'endsOn', code: FieldErrorCode.ENDS_BEFORE_START }];
  if (daysBetween(startsOn, endsOn) > MAX_PROGRAM_DAYS)
    return [
      {
        field: 'endsOn',
        code: FieldErrorCode.INVALID_VALUE,
        params: { maxDays: MAX_PROGRAM_DAYS },
      },
    ];
  return [];
}

/**
 * What an item of `kind` names, and nothing it does not (the CHECK
 * readiness_items_kind_shape): a contract only for a review, a checklist
 * only for a campaign, an amount always for an estimate and optionally for
 * a task.
 */
export function kindProblems(
  kind: ReadinessItemKind,
  i: { contractId?: string; checklistId?: string; estimateAmount?: string },
): FieldError[] {
  const fields: FieldError[] = [];
  const need = (field: string, given: boolean, wanted: boolean) => {
    if (wanted && !given)
      fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
    if (!wanted && given)
      fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
  };
  need('contractId', i.contractId !== undefined, kind === 'contract_review');
  need(
    'checklistId',
    i.checklistId !== undefined,
    kind === 'inspection_campaign',
  );
  if (kind === 'estimate')
    need('estimateAmount', i.estimateAmount !== undefined, true);
  else if (kind !== 'task')
    need('estimateAmount', i.estimateAmount !== undefined, false);
  return fields;
}

/** More than 0, as the CHECK readiness_items_estimate_range says. */
export const positiveAmount = (v: string): boolean =>
  new Prisma.Decimal(v).gt(0);

export interface ItemState {
  doneAt: Date | null;
  cancelledAt: Date | null;
  estimateAmount: Prisma.Decimal | null;
}

export interface Readiness {
  items: number;
  done: number;
  cancelled: number;
  open: number;
  /** done / (items − cancelled), in whole percent; null with nothing to do. */
  percent: number | null;
  /** The items' estimates that still count (not called off), EGP. */
  budget: string;
}

/** A program's readiness, computed on read (ADR 0067). */
export function readinessOf(items: readonly ItemState[]): Readiness {
  let done = 0;
  let cancelled = 0;
  let budget = new Prisma.Decimal(0);
  for (const i of items) {
    if (i.cancelledAt) {
      cancelled++;
      continue;
    }
    if (i.doneAt) done++;
    if (i.estimateAmount) budget = budget.add(i.estimateAmount);
  }
  const counted = items.length - cancelled;
  return {
    items: items.length,
    done,
    cancelled,
    open: counted - done,
    percent: counted === 0 ? null : Math.floor((done * 100) / counted),
    budget: budget.toFixed(2),
  };
}

/** An item's state: done, called off, or open. */
export const itemState = (i: {
  doneAt: Date | null;
  cancelledAt: Date | null;
}): 'open' | 'done' | 'cancelled' =>
  i.doneAt ? 'done' : i.cancelledAt ? 'cancelled' : 'open';

/** A copy's days: every day moves by the same number of days as the start. */
export const shifted = (
  day: LocalDate,
  from: LocalDate,
  to: LocalDate,
): LocalDate => addDays(day, daysBetween(from, to));

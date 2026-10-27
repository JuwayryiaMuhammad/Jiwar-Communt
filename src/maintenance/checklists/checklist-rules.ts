import { createHash } from 'node:crypto';
import type { TicketPriority } from '@prisma/client';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';

/**
 * Checklists (ADR 0064): the closed lists the migration's CHECKs repeat,
 * and the rules a template's items and a run's answers follow.
 */
export const CHECKLIST_PURPOSES = ['pm', 'inspection', 'any'] as const;
export type ChecklistPurpose = (typeof CHECKLIST_PURPOSES)[number];
export const ITEM_KINDS = ['check', 'reading', 'photo', 'text'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const CHECK_RESULTS = ['pass', 'fail', 'na'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const METRIC_KEY = /^[a-z][a-z0-9_]{1,39}$/;
export const ITEM_LABEL = { min: 1, max: 200 };
export const ITEM_UNIT = { min: 1, max: 16 };
export const ANSWER_NOTE = { min: 1, max: 1000 };
export const MAX_ITEMS = 100;
export const PHOTOS_PER_ANSWER = 3;
/** A reading: up to 10 digits before the point and 4 after, either sign. */
export const READING = /^-?\d{1,10}(\.\d{1,4})?$/;

export interface ItemInput {
  kind: ItemKind;
  labelAr: string;
  labelEn: string;
  required?: boolean;
  metricKey?: string;
  unit?: string;
  minValue?: string;
  maxValue?: string;
  failCreatesTicket?: boolean;
  followUpCategoryId?: string;
  followUpPriority?: TicketPriority;
}

/** What each kind of item may carry, as field errors under `items.<i>`. */
export function itemProblems(items: readonly ItemInput[]): FieldError[] {
  const fields: FieldError[] = [];
  const at = (i: number, f: string, code: FieldErrorCode) =>
    fields.push({ field: `items.${i}.${f}`, code });
  for (const [i, it] of items.entries()) {
    const reading = it.kind === 'reading';
    if (reading && it.metricKey === undefined)
      at(i, 'metricKey', FieldErrorCode.FIELD_REQUIRED);
    for (const f of ['metricKey', 'unit', 'minValue', 'maxValue'] as const)
      if (!reading && it[f] !== undefined)
        at(i, f, FieldErrorCode.FIELD_NOT_ALLOWED);
    if (
      reading &&
      it.minValue !== undefined &&
      it.maxValue !== undefined &&
      Number(it.minValue) > Number(it.maxValue)
    )
      at(i, 'maxValue', FieldErrorCode.INVALID_VALUE);
    const fails = it.kind === 'check' || reading;
    if (it.failCreatesTicket && !fails)
      at(i, 'failCreatesTicket', FieldErrorCode.FIELD_NOT_ALLOWED);
    if (it.failCreatesTicket && fails) {
      if (it.followUpCategoryId === undefined)
        at(i, 'followUpCategoryId', FieldErrorCode.FIELD_REQUIRED);
      if (it.followUpPriority === undefined)
        at(i, 'followUpPriority', FieldErrorCode.FIELD_REQUIRED);
    }
    if (!it.failCreatesTicket) {
      if (it.followUpCategoryId !== undefined)
        at(i, 'followUpCategoryId', FieldErrorCode.FIELD_NOT_ALLOWED);
      if (it.followUpPriority !== undefined)
        at(i, 'followUpPriority', FieldErrorCode.FIELD_NOT_ALLOWED);
    }
  }
  return fields;
}

/** An item as an answer needs it. */
export interface AnswerItem {
  kind: ItemKind;
  minValue: { toString(): string } | null;
  maxValue: { toString(): string } | null;
}

export interface AnswerInput {
  result?: CheckResult;
  value?: string;
  note?: string;
}

/**
 * What an answer stores, or the field errors it earns: a check takes a
 * result; a reading a value, and fails when out of its range; a photo or a
 * note neither (its photos and its note are the answer). Any item takes a
 * note.
 */
export function answerOf(
  item: AnswerItem,
  a: AnswerInput,
): {
  result: CheckResult | null;
  value: string | null;
  problems: FieldError[];
} {
  const problems: FieldError[] = [];
  let result: CheckResult | null = null;
  let value: string | null = null;
  if (item.kind === 'check') {
    if (a.result === undefined)
      problems.push({ field: 'result', code: FieldErrorCode.FIELD_REQUIRED });
    else result = a.result;
    if (a.value !== undefined)
      problems.push({ field: 'value', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  } else if (item.kind === 'reading') {
    if (a.value === undefined)
      problems.push({ field: 'value', code: FieldErrorCode.FIELD_REQUIRED });
    else {
      value = a.value;
      const v = Number(a.value);
      const low =
        item.minValue === null ? null : Number(item.minValue.toString());
      const high =
        item.maxValue === null ? null : Number(item.maxValue.toString());
      result =
        (low !== null && v < low) || (high !== null && v > high)
          ? 'fail'
          : 'pass';
    }
    if (a.result !== undefined)
      problems.push({
        field: 'result',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  } else {
    if (a.result !== undefined)
      problems.push({
        field: 'result',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (a.value !== undefined)
      problems.push({ field: 'value', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  }
  return { result, value, problems };
}

/** Whether a required item is answered: its result, value, photo or note. */
export function answered(
  kind: ItemKind,
  a:
    | {
        result: string | null;
        value: unknown;
        note: string | null;
        photos: number;
      }
    | undefined,
): boolean {
  if (!a) return false;
  switch (kind) {
    case 'check':
      return a.result !== null;
    case 'reading':
      return a.value !== null;
    case 'photo':
      return a.photos > 0;
    case 'text':
      return a.note !== null;
  }
}

export interface Attested {
  runId: string;
  templateId: string;
  version: number;
  submittedById: string;
  submittedAt: Date;
  answers: {
    itemId: string;
    position: number;
    result: string | null;
    value: string | null;
    note: string | null;
    photoFileIds: string[];
  }[];
}

/**
 * The run's attestation (ADR 0064): SHA-256 of its canonical form — who
 * submitted it, when, and exactly what each item says, by position. The
 * inspector's digital signature: the stored hash proves later that the
 * answers are what was submitted.
 */
export function attestation(a: Attested): string {
  const canonical = JSON.stringify([
    'jiwar:checklist-run:v1',
    a.runId,
    a.templateId,
    a.version,
    a.submittedById,
    a.submittedAt.toISOString(),
    [...a.answers]
      .sort((x, y) => x.position - y.position)
      .map((x) => [
        x.position,
        x.itemId,
        x.result,
        x.value,
        x.note,
        [...x.photoFileIds].sort(),
      ]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

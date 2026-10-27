import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerOf,
  answered,
  attestation,
  CHECK_RESULTS,
  CHECKLIST_PURPOSES,
  itemProblems,
  ITEM_KINDS,
} from './checklist-rules';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261201090500_checklists/migration.sql',
  ),
  'utf8',
);
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

describe('checklist rules (ADR 0064)', () => {
  it('the closed lists are the CHECKs’', () => {
    expect(sql).toContain(`CHECK ("purpose" IN (${list(CHECKLIST_PURPOSES)}))`);
    expect(sql).toContain(`CHECK ("kind" IN (${list(ITEM_KINDS)}))`);
    expect(sql).toContain(`"result" IN (${list(CHECK_RESULTS)})`);
  });

  it('only a reading names a metric and a range; only a check or a reading opens a follow-up', () => {
    expect(
      itemProblems([
        {
          kind: 'reading',
          labelAr: 'ض',
          labelEn: 'Pressure',
          metricKey: 'bar',
          minValue: '2',
          maxValue: '4',
        },
        {
          kind: 'check',
          labelAr: 'ت',
          labelEn: 'Leaks',
          failCreatesTicket: true,
          followUpCategoryId: 'c',
          followUpPriority: 'urgent',
        },
      ]),
    ).toEqual([]);
    expect(
      itemProblems([
        {
          kind: 'reading',
          labelAr: 'ض',
          labelEn: 'P',
          minValue: '5',
          maxValue: '4',
        },
        {
          kind: 'photo',
          labelAr: 'ص',
          labelEn: 'Photo',
          unit: 'bar',
          failCreatesTicket: true,
        },
        { kind: 'check', labelAr: 'ت', labelEn: 'C', failCreatesTicket: true },
        {
          kind: 'text',
          labelAr: 'ن',
          labelEn: 'N',
          followUpPriority: 'normal',
        },
      ]),
    ).toEqual([
      { field: 'items.0.metricKey', code: 'FIELD_REQUIRED' },
      { field: 'items.0.maxValue', code: 'INVALID_VALUE' },
      { field: 'items.1.unit', code: 'FIELD_NOT_ALLOWED' },
      { field: 'items.1.failCreatesTicket', code: 'FIELD_NOT_ALLOWED' },
      { field: 'items.2.followUpCategoryId', code: 'FIELD_REQUIRED' },
      { field: 'items.2.followUpPriority', code: 'FIELD_REQUIRED' },
      { field: 'items.3.followUpPriority', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('a reading out of its range fails; a check takes its result; the others neither', () => {
    const reading = {
      kind: 'reading' as const,
      minValue: { toString: () => '2' },
      maxValue: { toString: () => '4' },
    };
    expect(answerOf(reading, { value: '3.5' })).toEqual({
      result: 'pass',
      value: '3.5',
      problems: [],
    });
    expect(answerOf(reading, { value: '4.0001' }).result).toBe('fail');
    expect(answerOf(reading, { value: '-1' }).result).toBe('fail');
    expect(
      answerOf({ ...reading, minValue: null, maxValue: null }, { value: '99' })
        .result,
    ).toBe('pass');
    expect(answerOf(reading, { result: 'pass' }).problems).toEqual([
      { field: 'value', code: 'FIELD_REQUIRED' },
      { field: 'result', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const check = { kind: 'check' as const, minValue: null, maxValue: null };
    expect(answerOf(check, { result: 'na', note: 'locked' })).toEqual({
      result: 'na',
      value: null,
      problems: [],
    });
    expect(
      answerOf({ ...check, kind: 'photo' }, { result: 'pass' }).problems,
    ).toEqual([{ field: 'result', code: 'FIELD_NOT_ALLOWED' }]);
  });

  it('answered: a result, a value, a photo or a note, by kind', () => {
    const blank = { result: null, value: null, note: null, photos: 0 };
    expect(answered('check', { ...blank, result: 'na' })).toBe(true);
    expect(answered('reading', blank)).toBe(false);
    expect(answered('photo', { ...blank, photos: 1 })).toBe(true);
    expect(answered('text', { ...blank, note: 'ok' })).toBe(true);
    expect(answered('check', undefined)).toBe(false);
  });

  it('the attestation is the run’s exact answers: any change, any order of input, tells', () => {
    const base = {
      runId: 'r',
      templateId: 't',
      version: 2,
      submittedById: 'u',
      submittedAt: new Date('2026-10-27T10:00:00.000Z'),
      answers: [
        {
          itemId: 'b',
          position: 2,
          result: 'fail',
          value: '4.5',
          note: null,
          photoFileIds: ['p2', 'p1'],
        },
        {
          itemId: 'a',
          position: 1,
          result: 'pass',
          value: null,
          note: 'ok',
          photoFileIds: [],
        },
      ],
    };
    const hash = attestation(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation({ ...base, answers: [...base.answers].reverse() })).toBe(
      hash,
    );
    expect(
      attestation({
        ...base,
        answers: [
          { ...base.answers[0], photoFileIds: ['p1', 'p2'] },
          base.answers[1],
        ],
      }),
    ).toBe(hash);
    expect(
      attestation({
        ...base,
        answers: [{ ...base.answers[0], value: '4.6' }, base.answers[1]],
      }),
    ).not.toBe(hash);
    expect(attestation({ ...base, submittedById: 'v' })).not.toBe(hash);
  });
});

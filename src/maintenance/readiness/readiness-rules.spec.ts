import { Prisma } from '@prisma/client';
import {
  kindProblems,
  readinessOf,
  shifted,
  titleProblems,
  windowProblems,
} from './readiness-rules';

const open = (amount?: string) => ({
  doneAt: null,
  cancelledAt: null,
  estimateAmount: amount ? new Prisma.Decimal(amount) : null,
});
const at = new Date('2026-12-01T08:00:00Z');

describe('readiness rules (ADR 0067)', () => {
  it('a program ends on or after its start, a year and a day at most', () => {
    expect(windowProblems('2027-02-10', '2027-02-10')).toEqual([]);
    expect(windowProblems('2027-02-10', '2027-02-09')).toEqual([
      { field: 'endsOn', code: 'ENDS_BEFORE_START' },
    ]);
    expect(windowProblems('2027-01-01', '2028-01-02')).toEqual([]);
    expect(windowProblems('2027-01-01', '2028-01-03')).toEqual([
      { field: 'endsOn', code: 'INVALID_VALUE', params: { maxDays: 366 } },
    ]);
  });

  it('an item names what its kind needs, and nothing it does not', () => {
    expect(kindProblems('task', { estimateAmount: '5' })).toEqual([]);
    expect(kindProblems('estimate', {})).toEqual([
      { field: 'estimateAmount', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      kindProblems('contract_review', {
        checklistId: 'c',
        estimateAmount: '1',
      }),
    ).toEqual([
      { field: 'contractId', code: 'FIELD_REQUIRED' },
      { field: 'checklistId', code: 'FIELD_NOT_ALLOWED' },
      { field: 'estimateAmount', code: 'FIELD_NOT_ALLOWED' },
    ]);
    expect(kindProblems('inspection_campaign', { checklistId: 'c' })).toEqual(
      [],
    );
  });

  it('a title is 1 to 120 characters once trimmed', () => {
    expect(titleProblems('x')).toEqual([]);
    expect(titleProblems('')).toHaveLength(1);
    expect(titleProblems('x'.repeat(121))).toHaveLength(1);
  });

  it('readiness is done over what is not called off; the budget leaves out what was called off', () => {
    expect(readinessOf([])).toEqual({
      items: 0,
      done: 0,
      cancelled: 0,
      open: 0,
      percent: null,
      budget: '0.00',
    });
    expect(
      readinessOf([
        { ...open('100.10'), doneAt: at },
        open('0.45'),
        open(),
        { ...open('999'), cancelledAt: at },
      ]),
    ).toEqual({
      items: 4,
      done: 1,
      cancelled: 1,
      open: 2,
      percent: 33,
      budget: '100.55',
    });
    expect(readinessOf([{ ...open(), cancelledAt: at }]).percent).toBeNull();
  });

  it('a copy moves every day by as many days as the start, across months and leap days', () => {
    expect(shifted('2027-02-20', '2027-03-01', '2028-02-18')).toBe(
      '2028-02-09',
    );
    expect(shifted('2027-03-30', '2027-03-01', '2028-02-18')).toBe(
      '2028-03-18',
    );
  });
});

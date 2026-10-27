import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import {
  findingText,
  INSPECTION_STATUSES,
  targetProblems,
} from './inspection-rules';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261201090700_inspections/migration.sql',
  ),
  'utf8',
);

describe('inspection rules (ADR 0064)', () => {
  it('the statuses and the cancel reasons are the CHECKs’', () => {
    for (const s of INSPECTION_STATUSES)
      expect(sql).toContain(`"status" = '${s}'`);
    expect(sql).toContain(
      `"cancel_reason" IN (${REASON_CODES.inspectionCancel.map((c) => `'${c}'`).join(', ')})`,
    );
  });

  it('one target, an asset or an area', () => {
    expect(targetProblems({ assetId: 'a' })).toEqual([]);
    expect(targetProblems({ commonAreaId: 'c' })).toEqual([]);
    expect(targetProblems({})).toEqual([
      { field: 'assetId', code: 'FIELD_REQUIRED' },
    ]);
    expect(targetProblems({ assetId: 'a', commonAreaId: 'c' })).toEqual([
      { field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });

  it('a finding’s words: the label, and the note when there is one, at most 2000', () => {
    expect(findingText('Fence intact', null)).toBe('Fence intact');
    expect(findingText('Fence intact', 'Two panels down')).toBe(
      'Fence intact: Two panels down',
    );
    expect(findingText('x', 'y'.repeat(3000))).toHaveLength(2000);
  });
});

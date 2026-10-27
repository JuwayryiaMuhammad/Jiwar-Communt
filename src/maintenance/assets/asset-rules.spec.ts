import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../categories/default-categories';
import { REASON_CODES } from '../../core/common/reasons';
import {
  ageYears,
  ASSET_CONDITIONS,
  ASSET_CRITICALITIES,
  DOCUMENT_KINDS,
  health,
} from './asset-rules';
import { DEFAULT_ASSET_TYPES } from './default-asset-types';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261201090300_asset_register/migration.sql',
  ),
  'utf8',
);
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

describe('asset rules (ADR 0064)', () => {
  it('the closed lists are the CHECKs’', () => {
    expect(sql).toContain(
      `CHECK ("criticality" IN (${list(ASSET_CRITICALITIES)}))`,
    );
    expect(sql).toContain(`CHECK ("condition" IN (${list(ASSET_CONDITIONS)}))`);
    expect(sql).toContain(`CHECK ("kind" IN (${list(DOCUMENT_KINDS)}))`);
    expect(sql).toContain(
      `"status_reason" IN (${list(REASON_CODES.assetOutOfService)})`,
    );
    expect(sql).toContain(
      `"status_reason" IN (${list(REASON_CODES.assetRetire)})`,
    );
  });

  it('the default types are the backfill’s, each under a default category', () => {
    const keys = new Set(DEFAULT_CATEGORIES.map((c) => c.key));
    for (const t of DEFAULT_ASSET_TYPES) {
      expect(sql).toContain(
        `('${t.key}', '${t.nameAr}', '${t.nameEn}', '${t.categoryKey}', ${t.lifeYears})`,
      );
      expect(keys.has(t.categoryKey)).toBe(true);
    }
    expect(
      sql.match(/^\s+\('[a-z_]+', '[^']+', '[^']+', '[a-z]+', \d+\)/gm),
    ).toHaveLength(DEFAULT_ASSET_TYPES.length);
  });

  it('health: 100 for a sound young asset; condition, downtime, age and open work take from it', () => {
    const sound = {
      condition: 'good' as const,
      status: 'in_service' as const,
      ageYears: 2,
      lifeYears: 10,
      openCorrective: 0,
      overduePlanned: 0,
    };
    expect(health(sound)).toEqual({ score: 100, band: 'good' });
    expect(health({ ...sound, ageYears: 8 })).toEqual({
      score: 90,
      band: 'good',
    });
    expect(
      health({ ...sound, condition: 'poor', status: 'out_of_service' }),
    ).toEqual({
      score: 45,
      band: 'watch',
    });
    expect(
      health({
        ...sound,
        condition: 'critical',
        ageYears: 12,
        openCorrective: 5,
        overduePlanned: 5,
      }),
    ).toEqual({ score: 0, band: 'poor' });
    expect(health({ ...sound, ageYears: null })).toEqual({
      score: 100,
      band: 'good',
    });
    expect(health({ ...sound, status: 'retired' })).toBeNull();
  });

  it('age in whole years, never negative', () => {
    expect(ageYears('2016-11-01', '2026-10-27')).toBe(9);
    expect(ageYears('2027-01-01', '2026-10-27')).toBe(0);
    expect(ageYears(null, '2026-10-27')).toBeNull();
  });
});

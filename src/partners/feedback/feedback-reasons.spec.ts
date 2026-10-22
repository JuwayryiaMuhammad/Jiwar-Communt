import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';
import { COMPLAINT_OUTCOMES } from './complaints.service';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261112090500_partner_ratings_complaints/migration.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('a complaint’s codes (ADR 0060)', () => {
  it('the reasons, the compensation asked and decided are the CHECKs’', () => {
    expect(sql).toContain(
      `"reason" IN (${quoted(REASON_CODES.partnerComplaint)})`,
    );
    expect(sql).toContain(
      `"compensation_ask" IN (${quoted(REASON_CODES.partnerCompensationAsk)})`,
    );
    expect(sql).toContain(
      `"compensation" IN (${quoted(REASON_CODES.partnerCompensationDecision)})`,
    );
  });

  it('a complaint is upheld or not; not upheld arranges nothing', () => {
    expect(COMPLAINT_OUTCOMES).toEqual(['upheld', 'not_upheld']);
    expect(sql).toContain(
      `("outcome" = 'not_upheld' AND "compensation" = 'none')`,
    );
  });
});

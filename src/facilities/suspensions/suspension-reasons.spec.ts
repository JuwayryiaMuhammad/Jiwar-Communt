import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');

describe('a suspension’s lift codes (ADR 0044, 0055)', () => {
  it('the staff’s and the system’s are the recreated CHECK’s and the mirror’s', () => {
    expect(
      read(
        'prisma/migrations/20261102091000_suspension_board_appeals/migration.sql',
      ),
    ).toContain(
      `IN (${quoted([
        ...REASON_CODES.bookingSuspensionLift,
        ...REASON_CODES.bookingSuspensionSystemLift,
      ])})`,
    );
    const mirror = read('packages/api/src/reasons.ts');
    for (const list of [
      'bookingSuspensionLift',
      'bookingSuspensionSystemLift',
    ] as const)
      expect(mirror).toContain(`${list}: [${quoted(REASON_CODES[list])}]`);
  });
});

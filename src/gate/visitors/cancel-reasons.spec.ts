import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../../core/common/reasons';

describe('visitor pass cancel reasons (ADR 0043)', () => {
  it('end in `other`, mirrored for the apps', () => {
    expect(REASON_CODES.visitorPassCancel).toContain('other');
    const mirror = readFileSync(
      join(__dirname, '../../../packages/api/src/reasons.ts'),
      'utf8',
    );
    const quoted = REASON_CODES.visitorPassCancel
      .map((c) => `'${c}'`)
      .join(', ');
    expect(mirror).toContain(`visitorPassCancel: [${quoted}]`);
  });
});

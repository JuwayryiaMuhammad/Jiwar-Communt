import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  certificateState,
  noticeDue,
  STAFF_CERTIFICATE_KINDS,
} from './certificate-rules';

const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20270612090200_staff_certificates/migration.sql',
  ),
  'utf8',
);
const quoted = (l: readonly string[]) => l.map((c) => `'${c}'`).join(', ');

describe('staff certificates (ADR 0090)', () => {
  it('the kinds are the CHECK’s', () => {
    expect(sql).toContain(`"kind" IN (${quoted(STAFF_CERTIFICATE_KINDS)})`);
  });

  it('its expiry is its last day in force: expiring within 30 days, expired the day after', () => {
    const today = '2027-01-10';
    expect(certificateState('2027-02-10', today)).toBe('valid');
    expect(certificateState('2027-02-09', today)).toBe('expiring');
    expect(certificateState('2027-01-10', today)).toBe('expiring');
    expect(certificateState('2027-01-09', today)).toBe('expired');
  });

  it('warned once 30 days ahead, told once on the day, never late', () => {
    const none = { warnedFor: null, dayToldFor: null };
    expect(noticeDue({ expiresOn: '2027-02-10', ...none }, '2027-01-10')).toBe(
      null,
    );
    expect(noticeDue({ expiresOn: '2027-02-09', ...none }, '2027-01-10')).toBe(
      'expiring',
    );
    expect(
      noticeDue(
        { expiresOn: '2027-02-09', warnedFor: '2027-02-09', dayToldFor: null },
        '2027-01-10',
      ),
    ).toBe(null);
    // A renewal is a new expiry: warned again.
    expect(
      noticeDue(
        { expiresOn: '2027-03-01', warnedFor: '2027-02-09', dayToldFor: null },
        '2027-02-05',
      ),
    ).toBe('expiring');
    expect(
      noticeDue(
        { expiresOn: '2027-02-09', warnedFor: '2027-02-09', dayToldFor: null },
        '2027-02-09',
      ),
    ).toBe('expires_today');
    expect(
      noticeDue(
        {
          expiresOn: '2027-02-09',
          warnedFor: '2027-02-09',
          dayToldFor: '2027-02-09',
        },
        '2027-02-09',
      ),
    ).toBe(null);
    // A day missed is not told late.
    expect(noticeDue({ expiresOn: '2027-02-09', ...none }, '2027-02-10')).toBe(
      null,
    );
  });
});

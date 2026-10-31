import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_CODES } from '../common/reasons';
import { CHARGE_KINDS, CHARGE_SOURCES } from './charges';

const read = (path: string) =>
  readFileSync(join(__dirname, '../../..', path), 'utf8').replace(/\s+/g, ' ');
const quoted = (codes: readonly string[]) =>
  codes.map((c) => `'${c}'`).join(', ');
const migration = (name: string) =>
  read(`prisma/migrations/${name}/migration.sql`);

describe('charges and booking extras: the closed lists are the CHECKs’ (ADR 0070)', () => {
  it('the invoice kinds only the port issues are the enum’s new values', () => {
    const kinds = migration('20270112090000_charge_invoice_kinds_enum');
    for (const kind of CHARGE_KINDS)
      expect(kinds).toContain(`ADD VALUE '${kind}'`);
  });

  it('a charge’s sources, its cancel reasons, and the credit note it writes', () => {
    const charges = migration('20270112090100_finance_charges');
    for (const source of CHARGE_SOURCES)
      expect(charges).toContain(`"source" = '${source}'`);
    expect(charges).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.chargeCancel)})`,
    );
    expect(charges).toContain(
      `"reason_code" IN (${quoted([
        ...REASON_CODES.creditNote,
        ...REASON_CODES.creditNoteSystem,
      ])})`,
    );
  });

  it('a club membership request’s cancel reasons', () => {
    expect(migration('20270112090200_club_membership_requests')).toContain(
      `"cancel_reason" IN (${quoted(REASON_CODES.clubRequestCancel)})`,
    );
  });
});

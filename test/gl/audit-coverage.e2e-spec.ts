import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { addDays } from '../../src/core/common/slots/day-slots';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { auditReaders } from '../setup/audit';
import { M35_COVERAGE } from '../setup/audit-coverage-split';
import { day } from '../setup/compound-clock';
import { financeHelpers } from '../setup/finance';
import { glAccountId } from '../setup/gl-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per entry of the general ledger's catalog (ADR 0014,
 * 0092): the actor, the compound, ids, codes, numbers, days and amounts —
 * a manual entry's words as `{ changed }` only.
 */
const covered = new Set<string>();

describe('Audit coverage — the general ledger', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof financeHelpers>['setUp']>>;
  let suspense: string;
  let opening: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    read = auditReaders(h);
    s = await f.setUp('Ledger Audit Court');
    const key = (k: string) =>
      f.x.asManager(s.c, () =>
        h.moduleRef
          .get(TenantTx)
          .withTenantTx((tx) => glAccountId(tx, s.c.tenantId, k)),
      );
    suspense = await key('suspense');
    opening = await key('opening_balances');
  }, 90_000);

  afterAll(() => h.close());

  const rows = (action: string, targetId: string) =>
    read.tenant(s.c.tenantId, { action, targetId });
  const entry = (memo: string) =>
    f
      .http('post', '/staff/finance/gl/manual-entries', s.accountant.token, {
        postedOn: day(0),
        memo,
        lines: [
          { accountId: suspense, debit: '40.00' },
          { accountId: opening, credit: '40.00' },
        ],
      })
      .expect(201)
      .then((r) => r.body as { id: string; number: string });

  it('gl_account.created, .updated and .deleted — a sub-account added, renamed and removed unused', async () => {
    const made = (
      await f
        .http('post', '/staff/finance/gl/accounts', s.accountant.token, {
          parentId: suspense,
          code: '1900.1',
          nameEn: 'Unknown transfers',
          nameAr: 'تحويلات مجهولة',
        })
        .expect(201)
    ).body as { id: string };
    expect(
      (await rows('gl_account.created', made.id)).map((r) => [
        r.actorId,
        r.changes,
      ]),
    ).toEqual([
      [
        s.accountant.id,
        {
          code: { from: null, to: '1900.1' },
          parentId: { from: null, to: suspense },
          type: { from: null, to: 'asset' },
          nameEn: { from: null, to: 'Unknown transfers' },
          nameAr: { from: null, to: 'تحويلات مجهولة' },
        },
      ],
    ]);
    covered.add('gl_account.created');
    await f
      .http(
        'patch',
        `/staff/finance/gl/accounts/${made.id}`,
        s.accountant.token,
        {
          nameEn: 'Unmatched transfers',
        },
      )
      .expect(200);
    await f
      .http(
        'patch',
        `/staff/finance/gl/accounts/${made.id}`,
        s.accountant.token,
        {
          nameEn: 'Unmatched transfers',
        },
      )
      .expect(200);
    expect(
      (await rows('gl_account.updated', made.id)).map((r) => r.changes),
    ).toEqual([
      { nameEn: { from: 'Unknown transfers', to: 'Unmatched transfers' } },
    ]);
    covered.add('gl_account.updated');
    await f
      .http(
        'delete',
        `/staff/finance/gl/accounts/${made.id}`,
        s.accountant.token,
      )
      .expect(204);
    expect(
      (await rows('gl_account.deleted', made.id)).map((r) => r.metadata),
    ).toEqual([{ code: '1900.1', parentId: suspense }]);
    covered.add('gl_account.deleted');
  });

  it('gl_manual_entry.submitted and .approved — its words as changed only; the entry it posted', async () => {
    const made = await entry('Clear the suspense');
    const [sub] = await rows('gl_manual_entry.submitted', made.id);
    expect([sub.actorId, sub.changes]).toEqual([
      s.accountant.id,
      {
        number: { from: null, to: made.number },
        postedOn: { from: null, to: day(0) },
        lines: { from: null, to: 2 },
        total: { from: null, to: '40.00' },
        memo: { changed: true },
      },
    ]);
    covered.add('gl_manual_entry.submitted');
    const ok = (
      await f
        .http(
          'post',
          `/staff/finance/gl/manual-entries/${made.id}/approve`,
          s.manager.token,
        )
        .expect(201)
    ).body as { entryId: string };
    expect(
      (await rows('gl_manual_entry.approved', made.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([
      [
        s.manager.id,
        { number: made.number, entryId: ok.entryId, postedOn: day(0) },
      ],
    ]);
    covered.add('gl_manual_entry.approved');
  });

  it('gl_manual_entry.rejected and .withdrawn — the reason code; the maker taking it back', async () => {
    const no = await entry('Not needed');
    await f
      .http(
        'post',
        `/staff/finance/gl/manual-entries/${no.id}/reject`,
        s.manager.token,
        { reasonCode: 'not_needed' },
      )
      .expect(201);
    expect(
      (await rows('gl_manual_entry.rejected', no.id)).map((r) => r.metadata),
    ).toEqual([{ number: no.number, reasonCode: 'not_needed' }]);
    covered.add('gl_manual_entry.rejected');
    const mine = await entry('Mine');
    await f
      .http(
        'post',
        `/staff/finance/gl/manual-entries/${mine.id}/withdraw`,
        s.accountant.token,
      )
      .expect(201);
    expect(
      (await rows('gl_manual_entry.withdrawn', mine.id)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.accountant.id, { number: mine.number }]]);
    covered.add('gl_manual_entry.withdrawn');
  });

  it('gl_period.closed and .reopened — the months closed; the month reopened and why, by the manager', async () => {
    const last = addDays(`${day(0).slice(0, 7)}-01`, -1).slice(0, 7);
    await f
      .http('post', '/staff/finance/gl/periods/close', s.accountant.token, {
        month: last,
      })
      .expect(201);
    expect(
      (await rows('gl_period.closed', s.c.tenantId)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.accountant.id, { months: [last] }]]);
    covered.add('gl_period.closed');
    await f
      .http('post', '/staff/finance/gl/periods/reopen', s.manager.token, {
        month: last,
        reasonCode: 'audit_finding',
      })
      .expect(201);
    expect(
      (await rows('gl_period.reopened', s.c.tenantId)).map((r) => [
        r.actorId,
        r.metadata,
      ]),
    ).toEqual([[s.manager.id, { month: last, reasonCode: 'audit_finding' }]]);
    covered.add('gl_period.reopened');
  });

  describe('catalog completeness', () => {
    it('every entry of the general ledger has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M35_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M35_COVERAGE].sort());
    });
  });
});

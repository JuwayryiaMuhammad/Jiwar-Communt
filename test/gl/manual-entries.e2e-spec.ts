import { Prisma } from '@prisma/client';
import { addDays } from '../../src/core/common/slots/day-slots';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { err } from '../api/request';
import { day, dbDate, ofDbDate } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { glAccountId } from '../setup/gl-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Manual {
  id: string;
  number: string;
  status: string;
  postedOn: string;
  entryId: string | null;
  reversesEntryId: string | null;
  rejectReason: string | null;
  debit: string;
  lines: { accountId: string; debit: string; credit: string }[];
}
interface Period {
  month: string;
  status: string;
  ended: boolean;
  reopenReason: string | null;
}

/**
 * ADR 0092: a manual journal entry takes effect only once a second person
 * approves it — never its maker — balanced, on accounts no register keeps,
 * in an open month; a correction is a reversing entry. A month is closed
 * once it has ended, and the database then refuses any entry dated in it:
 * an automatic event of that month posts on the next open day. Reopening is
 * the manager's alone.
 */
describe('The general ledger — manual entries and closed months (ADR 0092)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  const key: Record<string, string> = {};

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Ledger Court');
    for (const k of [
      'suspense',
      'opening_balances',
      'receivables',
      'assets',
      'expense:other',
    ])
      key[k] = await inTx((tx) => glAccountId(tx, s.c.tenantId, k));
  }, 90_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const acc = () => s.accountant.token;
  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    f.x.asManager(s.c, () => h.moduleRef.get(TenantTx).withTenantTx(fn));
  const thisMonth = () => `${day(0).slice(0, 7)}-01`;
  const lastMonthEnd = () => addDays(thisMonth(), -1);
  const lastMonth = () => lastMonthEnd().slice(0, 7);
  const submit = (body: object, token = acc()) =>
    f.http('post', '/staff/finance/gl/manual-entries', token, {
      postedOn: day(0),
      memo: 'Reclassify the suspense',
      lines: [
        { accountId: key.suspense, debit: '250.00' },
        { accountId: key.opening_balances, credit: '250.00' },
      ],
      ...body,
    });
  const act = (id: string, action: string, token: string, body: object = {}) =>
    f.http(
      'post',
      `/staff/finance/gl/manual-entries/${id}/${action}`,
      token,
      body,
    );
  const notices = (accountId: string, kind: string, targetId: string) =>
    inTx((tx) =>
      tx.notification.count({ where: { accountId, kind, targetId } }),
    );

  it('refuses an entry that does not balance, a control account, a heading, a day past this month and a line of both sides', async () => {
    expect(
      err(
        await submit({
          lines: [
            { accountId: key.suspense, debit: '250.00' },
            { accountId: key.opening_balances, credit: '200.00' },
          ],
        }).expect(400),
      ),
    ).toMatchObject({
      code: 'GL_ENTRY_UNBALANCED',
      params: { debit: '250.00', credit: '200.00' },
    });
    expect(
      err(
        await submit({
          lines: [
            { accountId: key.receivables, debit: '10' },
            { accountId: key.opening_balances, credit: '10' },
          ],
        }).expect(409),
      ),
    ).toMatchObject({
      code: 'GL_ACCOUNT_CONTROLLED',
      params: { accountId: key.receivables },
    });
    expect(
      err(
        await submit({
          lines: [
            { accountId: key.assets, debit: '10' },
            { accountId: key.opening_balances, credit: '10' },
          ],
        }).expect(409),
      ).code,
    ).toBe('GL_ACCOUNT_NOT_POSTABLE');
    const after = `${addDays(thisMonth(), 40).slice(0, 7)}-01`;
    expect(err(await submit({ postedOn: after }).expect(400)).fields).toEqual([
      {
        field: 'postedOn',
        code: 'INVALID_VALUE',
        params: { max: addDays(after, -1) },
      },
    ]);
    expect(
      err(
        await submit({
          lines: [
            { accountId: key.suspense, debit: '10', credit: '10' },
            { accountId: key.opening_balances, credit: '10' },
          ],
        }).expect(400),
      ).fields,
    ).toEqual([
      {
        field: 'lines.0.debit',
        code: 'INVALID_VALUE',
        params: { oneOf: ['debit', 'credit'] },
      },
    ]);
  });

  it('pending until a second person approves it: its maker never does; approved, it posts once and its maker is told', async () => {
    const made = (await submit({}).expect(201)).body as Manual;
    expect(made).toMatchObject({
      status: 'pending',
      entryId: null,
      debit: '250.00',
    });
    expect(made.number).toMatch(/^JE-\d{6}$/);
    expect(
      await notices(s.manager.id, 'gl_manual_entry.submitted', made.id),
    ).toBe(1);
    expect(
      await notices(s.accountant.id, 'gl_manual_entry.submitted', made.id),
    ).toBe(0);
    const inbox = (
      await f.http('get', '/staff/inbox?type=gl_manual_entry', m()).expect(200)
    ).body as { data: { id: string; number: string }[] };
    expect(inbox.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: made.id, number: made.number }),
      ]),
    );
    expect(err(await act(made.id, 'approve', acc()).expect(409)).code).toBe(
      'GL_SELF_APPROVAL',
    );
    expect(
      err(
        await act(made.id, 'reject', acc(), {
          reasonCode: 'not_needed',
        }).expect(409),
      ).code,
    ).toBe('GL_SELF_APPROVAL');
    const ok = (await act(made.id, 'approve', m()).expect(201)).body as Manual;
    expect(ok).toMatchObject({ status: 'approved' });
    const entry = (
      await f
        .http('get', `/staff/finance/gl/entries/${ok.entryId}`, acc())
        .expect(200)
    ).body as {
      source: string;
      reference: string;
      memo: string;
      lines: { accountId: string; debit: string; credit: string }[];
    };
    expect(entry).toMatchObject({
      source: 'manual',
      reference: made.number,
      memo: 'Reclassify the suspense',
    });
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountId: key.suspense, debit: '250.00' }),
      expect.objectContaining({
        accountId: key.opening_balances,
        credit: '250.00',
      }),
    ]);
    expect(
      await notices(s.accountant.id, 'gl_manual_entry.decided', made.id),
    ).toBe(1);
    expect(err(await act(made.id, 'approve', m()).expect(409))).toMatchObject({
      code: 'GL_MANUAL_ENTRY_STATE',
      params: { status: 'approved' },
    });
  });

  it('a correction is a reversing entry, of a manual entry only, once; turned down, it may be written again; its maker withdraws a pending one', async () => {
    const made = (await submit({ memo: 'To reverse' }).expect(201))
      .body as Manual;
    const posted = (await act(made.id, 'approve', m()).expect(201))
      .body as Manual;
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    const automatic = await inTx(
      async (tx) =>
        (
          await tx.glEntry.findFirstOrThrow({
            where: { source: 'invoice', sourceId: invoiceId },
          })
        ).id,
    );
    const reverse = (entryId: string, token = acc()) =>
      f.http('post', `/staff/finance/gl/entries/${entryId}/reverse`, token, {
        postedOn: day(0),
        memo: 'Entered twice',
      });
    expect(err(await reverse(automatic).expect(409))).toMatchObject({
      code: 'GL_ENTRY_NOT_REVERSIBLE',
      params: { reason: 'automatic' },
    });
    const rev = (await reverse(posted.entryId!).expect(201)).body as Manual;
    expect(rev).toMatchObject({
      status: 'pending',
      reversesEntryId: posted.entryId,
    });
    expect(rev.lines).toEqual([
      expect.objectContaining({ accountId: key.suspense, credit: '250.00' }),
      expect.objectContaining({
        accountId: key.opening_balances,
        debit: '250.00',
      }),
    ]);
    expect(err(await reverse(posted.entryId!).expect(409))).toMatchObject({
      code: 'GL_ENTRY_REVERSED',
      params: { manualEntryId: rev.id },
    });
    const no = (
      await act(rev.id, 'reject', m(), { reasonCode: 'wrong_date' }).expect(201)
    ).body as Manual;
    expect(no).toMatchObject({
      status: 'rejected',
      rejectReason: 'wrong_date',
    });
    const again = (await reverse(posted.entryId!).expect(201)).body as Manual;
    expect(err(await act(again.id, 'withdraw', m()).expect(403)).code).toBe(
      'FORBIDDEN',
    );
    expect(
      ((await act(again.id, 'withdraw', acc()).expect(201)).body as Manual)
        .status,
    ).toBe('withdrawn');
  });

  it('a month is closed once it has ended; nothing is then dated in it, an event of it posts on the next open day, and only the manager reopens it', async () => {
    // A pending entry dated last month, to approve after the close.
    const late = (
      await submit({ postedOn: lastMonthEnd(), memo: 'Late accrual' }).expect(
        201,
      )
    ).body as Manual;
    expect(
      err(
        await f
          .http('post', '/staff/finance/gl/periods/close', acc(), {
            month: day(0).slice(0, 7),
          })
          .expect(409),
      ),
    ).toMatchObject({
      code: 'GL_PERIOD_NOT_ENDED',
      params: { month: day(0).slice(0, 7) },
    });
    const closed = (
      await f
        .http('post', '/staff/finance/gl/periods/close', acc(), {
          month: lastMonth(),
        })
        .expect(201)
    ).body as { data: Period[] };
    expect(closed.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ month: lastMonth(), status: 'closed' }),
        expect.objectContaining({
          month: day(0).slice(0, 7),
          status: 'open',
          ended: false,
        }),
      ]),
    );
    expect(
      err(
        await f
          .http('post', '/staff/finance/gl/periods/close', acc(), {
            month: lastMonth(),
          })
          .expect(409),
      ).code,
    ).toBe('GL_PERIOD_CLOSED');
    expect(
      err(await submit({ postedOn: lastMonthEnd() }).expect(409)),
    ).toMatchObject({
      code: 'GL_PERIOD_CLOSED',
      params: { month: lastMonth() },
    });
    expect(err(await act(late.id, 'approve', m()).expect(409)).code).toBe(
      'GL_PERIOD_CLOSED',
    );
    // An office payment paid on last month's last day posts on this
    // month's first, keeping its own day.
    const { invoiceId } = await f.issue(s.accountant, s.home.id);
    expect(invoiceId).toBeDefined();
    const pay = (
      await f
        .http('post', `/staff/units/${s.home.id}/payments`, acc(), {
          amount: '100',
          method: 'cash',
          paidOn: lastMonthEnd(),
        })
        .expect(201)
    ).body as { id: string };
    const entry = await inTx((tx) =>
      tx.glEntry.findFirstOrThrow({
        where: { source: 'payment', sourceId: pay.id },
      }),
    );
    expect([ofDbDate(entry.postedOn), ofDbDate(entry.eventOn)]).toEqual([
      thisMonth(),
      lastMonthEnd(),
    ]);
    // The database refuses an entry dated in it, whatever writes it.
    await expect(
      inTx((tx) =>
        tx.glEntry.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            postedOn: dbDate(lastMonthEnd()),
            eventOn: dbDate(lastMonthEnd()),
            source: 'manual',
            sourceId: newId(),
          },
        }),
      ),
    ).rejects.toThrow(/closed month/);
    expect(
      err(
        await f
          .http('post', '/staff/finance/gl/periods/reopen', acc(), {
            month: lastMonth(),
            reasonCode: 'correction',
          })
          .expect(403),
      ).code,
    ).toBe('FORBIDDEN');
    const reopened = (
      await f
        .http('post', '/staff/finance/gl/periods/reopen', m(), {
          month: lastMonth(),
          reasonCode: 'late_document',
        })
        .expect(201)
    ).body as { data: Period[] };
    expect(reopened.data.find((p) => p.month === lastMonth())).toMatchObject({
      status: 'open',
      reopenReason: 'late_document',
    });
    expect(
      err(
        await f
          .http('post', '/staff/finance/gl/periods/reopen', m(), {
            month: lastMonth(),
            reasonCode: 'late_document',
          })
          .expect(409),
      ).code,
    ).toBe('GL_PERIOD_NOT_CLOSED');
    expect(
      ((await act(late.id, 'approve', m()).expect(201)).body as Manual).status,
    ).toBe('approved');
  });

  it('the database keeps every entry balanced, its lines in its own transaction, and nothing rewritten', async () => {
    await expect(
      inTx(async (tx) => {
        const id = newId();
        await tx.$executeRaw`
          INSERT INTO gl_entries (id, tenant_id, posted_on, event_on, source, source_id)
          VALUES (${id}::uuid, ${s.c.tenantId}::uuid, ${day(0)}::date, ${day(0)}::date,
                  'manual', ${newId()}::uuid)`;
        await tx.$executeRaw`
          INSERT INTO gl_lines (tenant_id, entry_id, line_no, account_id, debit, posted_on, entry_seq)
          VALUES (${s.c.tenantId}::uuid, ${id}::uuid, 1, ${key.suspense}::uuid, 10, ${day(0)}::date, 0),
                 (${s.c.tenantId}::uuid, ${id}::uuid, 2, ${key['expense:other']}::uuid, 5, ${day(0)}::date, 0)`;
      }),
    ).rejects.toThrow(/must balance/);
    const old = await inTx((tx) =>
      tx.glEntry.findFirstOrThrow({ where: { source: 'manual' } }),
    );
    await expect(
      inTx(
        (tx) => tx.$executeRaw`
          INSERT INTO gl_lines (tenant_id, entry_id, line_no, account_id, debit, posted_on, entry_seq)
          VALUES (${s.c.tenantId}::uuid, ${old.id}::uuid, 90, ${key.suspense}::uuid, 1, ${day(0)}::date, 0)`,
      ),
    ).rejects.toThrow(/another transaction/);
    await expect(
      inTx(
        (tx) => tx.$executeRaw`
          UPDATE gl_lines SET debit = debit + ${new Prisma.Decimal(1)} WHERE entry_id = ${old.id}::uuid`,
      ),
    ).rejects.toThrow();
  });
});

import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import { day, dbClock, today } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const NAME = 'Lindqvist Searched-Visitor';

interface Found {
  from: string;
  to: string;
  entries: { id: string; unitCode: string; subjectType: string }[];
  truncated: boolean;
}

/**
 * ADR 0056, the gate log search: the management finds a visitor's entries
 * by their full name, exactly — never by a part of it or a likeness — within
 * 31 of the compound's days, of a unit. The name rests nowhere: not in an
 * idempotency record (the route keeps none), the audit (`byName` only), the
 * outbox, a notification or a log line. Rate-limited per account.
 */
describe('Gate — the gate log search (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let entryId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Log Search Court');
    read = auditReaders(h);
    const p = await g.pass(s.alice, s.home.id, { visitorName: NAME });
    entryId = await g.enter(s.guard, 'visitor_pass', p.id);
  }, 180_000);

  afterAll(() => h.close());

  const searchRaw = (
    body: Record<string, unknown>,
    as = s.manager,
    headers: Record<string, string> = {},
  ) =>
    g.http(
      'post',
      '/staff/gate/log-search',
      as.token,
      { from: today(), to: today(), ...body },
      headers,
    );
  const ids = async (body: Record<string, unknown>) =>
    ((await searchRaw(body).expect(200)).body as Found).entries.map(
      (e) => e.id,
    );

  it('the visitor named exactly, however it is typed; never a part of it or a likeness', async () => {
    expect(await ids({ visitorName: NAME })).toEqual([entryId]);
    expect(
      await ids({ visitorName: `  lindqvist   SEARCHED-visitor ` }),
    ).toEqual([entryId]);
    for (const visitorName of [
      'Lindqvist',
      'Searched-Visitor',
      'Lindqvist Searched-Visito',
      'Lindkvist Searched-Visitor',
    ])
      expect(await ids({ visitorName })).toEqual([]);
  });

  it('by unit and by days; the answer names nobody', async () => {
    const found = (await searchRaw({ unitId: s.home.id }).expect(200))
      .body as Found;
    expect(found.entries.map((e) => e.id)).toContain(entryId);
    expect(JSON.stringify(found)).not.toContain('Lindqvist');
    const other = await g.unit(s.c);
    expect(await ids({ unitId: other.id })).toEqual([]);
    expect(
      await ids({ visitorName: NAME, from: day(-3), to: day(-1) }),
    ).toEqual([]);
  });

  it('audited with what it asked and found, never the name', async () => {
    await searchRaw({ visitorName: NAME, unitId: s.home.id }).expect(200);
    const rows = await read.tenant(s.c.tenantId, {
      action: 'gate.log_searched',
      targetId: s.c.tenantId,
    });
    expect(rows.at(-1)).toMatchObject({
      actorType: 'account',
      actorId: s.manager.id,
      metadata: {
        from: today(),
        to: today(),
        unitId: s.home.id,
        byName: true,
        results: 1,
        truncated: false,
      },
    });
    expect(JSON.stringify(rows)).not.toContain('Lindqvist');
  });

  it('the name rests nowhere: no idempotency record, audit, outbox, notification or log line', async () => {
    const since = new Date(dbClock().getTime() - 60_000);
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const capture =
      (into: typeof out) =>
      (chunk: string | Uint8Array, ...rest: unknown[]) => {
        written.push(String(chunk));
        return (into as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
    process.stdout.write = capture(out);
    process.stderr.write = capture(err);
    try {
      // With a key the client sent anyway, and on a refusal too.
      await searchRaw({ visitorName: NAME }, s.manager, {
        'Idempotency-Key': '0192e000-0000-7000-8000-00000000d001',
      }).expect(200);
      await searchRaw({ visitorName: NAME, from: day(-40) }).expect(400);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    expect(written.join('')).not.toContain('Lindqvist');
    const rows = await g.inTx(s.c, async (tx) => ({
      keys: await tx.idempotencyKey.findMany({
        where: { accountId: s.manager.id, createdAt: { gte: since } },
      }),
      audit: await tx.auditLog.findMany({
        where: { occurredAt: { gte: since } },
      }),
      notifications: await tx.notification.findMany({
        where: { createdAt: { gte: since } },
      }),
      outbox: await h.moduleRef.get(GlobalDbService).outboxMessage.findMany({
        where: { tenantId: s.c.tenantId, createdAt: { gte: since } },
      }),
    }));
    expect(rows.keys.filter((k) => k.route.includes('log-search'))).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('Lindqvist');
  });

  it('31 days at most; a name that folds to nothing is no name; the manager only', async () => {
    const long = await searchRaw({ from: day(-40) }).expect(400);
    expect((long.body as { fields: unknown[] }).fields).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
    ]);
    const blank = await searchRaw({ visitorName: 'ـ ـ' }).expect(400);
    expect((blank.body as { fields: unknown[] }).fields).toEqual([
      { field: 'visitorName', code: 'FIELD_REQUIRED' },
    ]);
    await searchRaw({}, s.guard).expect(403);
    await searchRaw({}, await g.supervisor(s.c)).expect(403);
  });

  it('twenty searches in ten minutes per account; the next is refused', async () => {
    const searcher = await g.manager(s.c);
    for (let i = 0; i < 20; i++) await searchRaw({}, searcher).expect(200);
    const over = await searchRaw({}, searcher).expect(429);
    expect((over.body as { code: string }).code).toBe('RATE_LIMITED');
    // Another account is not held back by it.
    await searchRaw({}).expect(200);
  });
});

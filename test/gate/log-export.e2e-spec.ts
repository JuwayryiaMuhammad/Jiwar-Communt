import { LOG_EXPORT_COLUMNS } from '../../src/gate/entries/log-search.service';
import { auditReaders } from '../setup/audit';
import { day, today } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const NAME = 'Okonkwo Exported-Visitor';

/** A CSV's rows, the byte-order mark and CRLF taken off. */
function rowsOf(body: string): string[][] {
  return body
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter((l) => l.length)
    .map((l) => l.split(','));
}

/**
 * ADR 0079: the gate log searched to a CSV. The same body and rules as the
 * search (ADR 0056): the compound's days (31 at most), a unit, a visitor
 * named exactly; the search's rate; no idempotency record. Every export is
 * audited with what it asked and how many rows, never the name; the file
 * names nobody but the units' codes, as the search does.
 */
describe('Gate — the gate log export (ADR 0079)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let entryId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Log Export Court');
    read = auditReaders(h);
    const p = await g.pass(s.alice, s.home.id, { visitorName: NAME });
    entryId = await g.enter(s.guard, 'visitor_pass', p.id);
  }, 180_000);

  afterAll(() => h.close());

  const exportRaw = (body: Record<string, unknown>, as = s.manager) =>
    g.http('post', '/staff/gate/log-search/export', as.token, {
      from: today(),
      to: today(),
      ...body,
    });

  it('the search’s entries as CSV, no-store, the name nowhere in it', async () => {
    const res = await exportRaw({ visitorName: NAME }).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    const [header, ...rows] = rowsOf(text);
    expect(header).toEqual(LOG_EXPORT_COLUMNS.map((c) => c.header));
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe('in');
    expect(rows[0][3]).toBe('visitor_pass');
    expect(rows[0][5]).toBe(s.home.code);
    expect(text).not.toContain('Okonkwo');
    expect(text).not.toContain(entryId);
  });

  it('by unit and days: another unit, or other days, export the header only', async () => {
    const other = await g.unit(s.c);
    expect(
      rowsOf((await exportRaw({ unitId: other.id }).expect(200)).text),
    ).toHaveLength(1);
    expect(
      rowsOf(
        (await exportRaw({ from: day(-3), to: day(-1) }).expect(200)).text,
      ),
    ).toHaveLength(1);
  });

  it('audited with what it asked and how many rows, never the name', async () => {
    await exportRaw({ visitorName: NAME, unitId: s.home.id }).expect(200);
    const rows = await read.tenant(s.c.tenantId, {
      action: 'gate.log_exported',
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
        rows: 1,
      },
    });
    expect(JSON.stringify(rows)).not.toContain('Okonkwo');
  });

  it('the search’s rules: 31 days at most, the manager only, its rate shared', async () => {
    const long = await exportRaw({ from: day(-40) }).expect(400);
    expect((long.body as { fields: unknown[] }).fields).toEqual([
      { field: 'to', code: 'PERIOD_TOO_LONG', params: { maxDays: 31 } },
    ]);
    await exportRaw({}, s.guard).expect(403);
    const searcher = await g.manager(s.c);
    for (let i = 0; i < 10; i++)
      await g
        .http('post', '/staff/gate/log-search', searcher.token, {
          from: today(),
          to: today(),
        })
        .expect(200);
    for (let i = 0; i < 10; i++) await exportRaw({}, searcher).expect(200);
    const over = await exportRaw({}, searcher).expect(429);
    expect((over.body as { code: string }).code).toBe('RATE_LIMITED');
  });
});

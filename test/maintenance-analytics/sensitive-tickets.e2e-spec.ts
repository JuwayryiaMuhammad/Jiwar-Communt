import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind } from '../setup/sla';

type Body = {
  code: string;
  fields?: { field: string; code: string }[];
  [key: string]: unknown;
};

interface Listed {
  data: { id: string; number: string; sensitive: boolean }[];
}

/**
 * ADR 0081: a ticket the dispatch marks sensitive is out of every staff
 * read path for a reader without `tickets.sensitive` (the maintenance
 * supervisor by default): the list on both of its paths, its CSV, the
 * search, a read by id and every route under it, an asset's timeline, the
 * SLA report; the manager (who holds it) sees it, and every staff read of
 * it is logged. Its technician keeps it; of the staff, only its technician
 * and the holders are told of it. Clearing it needs the permission; two
 * marks at once write one entry.
 */
describe('Maintenance analytics — sensitive tickets', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let secret: string;
  let plain: string;
  let secretNumber: string;

  const mark = (id: string, token: string, body: object) =>
    a.http('put', `/maintenance/tickets/${id}/sensitivity`, token, body);

  const ids = async (query: string, token = s.supervisor.token) =>
    (
      (await a.http('get', `/maintenance/tickets?${query}`, token).expect(200))
        .body as Listed
    ).data.map((t) => t.id);

  const csv = async (token: string) =>
    (
      await a
        .http(
          'get',
          `/maintenance/tickets/export?from=${addDays(today(), -30)}&to=${today()}`,
          token,
        )
        .buffer(true)
        .parse((r, done) => {
          let body = '';
          r.on('data', (c: Buffer) => (body += c.toString('utf8')));
          r.on('end', () => done(null, body));
        })
        .expect(200)
    ).body as string;

  const reads = (ticketId: string) =>
    a.inTenant(s.c, (tx) =>
      tx.ticketSensitiveRead.findMany({
        where: { ticketId },
        orderBy: [{ readAt: 'asc' }, { id: 'asc' }],
      }),
    );

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    secret = await a.openTicket(s, { category: 'plumbing' });
    plain = await a.openTicket(s, { category: 'plumbing' });
    const row = await a.ticketRow(s.c, secret);
    secretNumber = `MT-${String(row.number).padStart(6, '0')}`;
  }, 180_000);

  afterAll(() => h.close());

  it('marking takes a code from ticketSensitive; clearing one from ticketSensitiveClear', async () => {
    const res = await mark(secret, s.supervisor.token, {
      sensitive: true,
    }).expect(400);
    expect((res.body as Body).code).toBe('REASON_REQUIRED');
    const bad = await mark(secret, s.supervisor.token, {
      sensitive: true,
      reasonCode: 'marked_in_error',
    }).expect(400);
    expect((bad.body as Body).fields?.[0]).toMatchObject({
      field: 'reasonCode',
      code: 'INVALID_REASON_CODE',
    });
  });

  it('two marks at once: the ticket is sensitive once, with one entry; the supervisor loses it at once', async () => {
    const both = await Promise.all([
      mark(secret, s.supervisor.token, {
        sensitive: true,
        reasonCode: 'resident_privacy',
      }),
      mark(secret, s.manager.token, {
        sensitive: true,
        reasonCode: 'safeguarding',
      }),
    ]);
    // The manager's always lands (204); the supervisor's either wins or
    // finds a ticket it may no longer see.
    expect(both[1].status).toBe(204);
    expect([204, 404]).toContain(both[0].status);
    expect((await a.ticketRow(s.c, secret)).sensitive).toBe(true);
    const entries = await a.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'ticket.sensitivity_changed', targetId: secret },
      }),
    );
    expect(entries).toHaveLength(1);
    await a
      .http('get', `/maintenance/tickets/${secret}`, s.supervisor.token)
      .expect(404);
  });

  it('the supervisor’s list leaves it out on the plain path, by number and with `sensitive=true`', async () => {
    const all = await ids('');
    expect(all).toContain(plain);
    expect(all).not.toContain(secret);
    expect(await ids(`q=${secretNumber}`)).toEqual([]);
    expect(await ids('sensitive=true')).toEqual([]);
  });

  it('the manager’s list has it, flagged, and logs the read', async () => {
    const before = (await reads(secret)).length;
    const res = await a
      .http('get', '/maintenance/tickets?sensitive=true', s.manager.token)
      .expect(200);
    const rows = (res.body as Listed).data;
    expect(rows.map((r) => r.id)).toEqual([secret]);
    expect(rows[0].sensitive).toBe(true);
    const after = await reads(secret);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({
      accountId: s.manager.id,
      via: 'list',
    });
  });

  it('the operations dashboard counts it for the manager only (ADR 0079’s figures)', async () => {
    const open = async (token: string) =>
      (
        (await a.http('get', '/staff/dashboard', token).expect(200)).body as {
          figures: { maintenance: { open: number } | null };
        }
      ).figures.maintenance!.open;
    expect(await open(s.manager.token)).toBe(
      (await open(s.supervisor.token)) + 1,
    );
  });

  it('every route on it answers TICKET_NOT_FOUND to the supervisor; the manager’s are logged as `detail`', async () => {
    for (const path of [
      `/maintenance/tickets/${secret}`,
      `/maintenance/tickets/${secret}/history`,
      `/maintenance/tickets/${secret}/messages`,
    ]) {
      const res = await a.http('get', path, s.supervisor.token).expect(404);
      expect((res.body as Body).code).toBe('TICKET_NOT_FOUND');
    }
    await a
      .http(
        'post',
        `/maintenance/tickets/${secret}/assign`,
        s.supervisor.token,
        {
          technicianId: s.techs[0].id,
        },
      )
      .expect(404);
    await a
      .http('get', `/maintenance/tickets/${secret}`, s.manager.token)
      .expect(200);
    const last = (await reads(secret)).at(-1)!;
    expect(last).toMatchObject({ accountId: s.manager.id, via: 'detail' });
  });

  it('the export: in the manager’s CSV (logged), not in the supervisor’s', async () => {
    const number = secretNumber;
    expect(await csv(s.supervisor.token)).not.toContain(number);
    expect(await csv(s.manager.token)).toContain(number);
    expect((await reads(secret)).at(-1)).toMatchObject({ via: 'export' });
  });

  it('the staff search: a hit for the manager (logged), none for the supervisor', async () => {
    const hits = async (token: string) =>
      (
        (
          await a
            .http('get', `/staff/search?q=${secretNumber}`, token)
            .expect(200)
        ).body as { data: { type: string; id: string }[] }
      ).data.filter((x) => x.type === 'ticket');
    expect(await hits(s.supervisor.token)).toEqual([]);
    expect((await hits(s.manager.token)).map((x) => x.id)).toEqual([secret]);
    expect((await reads(secret)).at(-1)).toMatchObject({ via: 'search' });
  });

  it('assigned by the manager, its technician reads it (logged) and is told; declined, the manager is told and the supervisor is not', async () => {
    await a
      .http('post', `/maintenance/tickets/${secret}/assign`, s.manager.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    const res = await a
      .http('get', `/technician/tickets/${secret}`, s.techs[0].token)
      .expect(200);
    expect((res.body as { sensitive: boolean }).sensitive).toBe(true);
    expect((await reads(secret)).at(-1)).toMatchObject({
      accountId: s.techs[0].id,
      via: 'detail',
    });
    // Declined: the dispatch is told (ADR 0032), of the staff only the holders.
    await a
      .http('post', `/technician/tickets/${secret}/decline`, s.techs[0].token, {
        reasonCode: 'not_my_specialty',
      })
      .expect(204);
    const told = async (kind: string) =>
      (
        await a.inTenant(s.c, (tx) =>
          tx.notification.findMany({ where: { targetId: secret, kind } }),
        )
      ).map((n) => n.accountId);
    expect(await told('ticket.assigned')).toContain(s.techs[0].id);
    const declined = await told('ticket.declined');
    expect(declined).toContain(s.manager.id);
    expect(declined).not.toContain(s.supervisor.id);
  });

  it('the SLA-flagged path leaves it out for the supervisor, keeps it for the manager', async () => {
    await a
      .http('patch', '/maintenance/sla-settings', s.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    const cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    await cls.run(async () => {
      cls.set('tenantId', s.c.tenantId);
      await h.moduleRef.get(SlaSweep).pass();
    });
    await rewind(secret, 10 * 24 * 60);
    await rewind(plain, 10 * 24 * 60);
    const supervisor = await ids('overdue=true');
    expect(supervisor).toContain(plain);
    expect(supervisor).not.toContain(secret);
    expect(await ids('overdue=true', s.manager.token)).toContain(secret);
  });

  it('an asset’s timeline leaves its rows out for the supervisor', async () => {
    const assetId = await a.asset(s);
    const plumbing = await a.categoryId(s.c, 'plumbing');
    const res = await a
      .http('post', '/maintenance/work-orders', s.manager.token, {
        assetId,
        categoryId: plumbing,
        description: 'Seal fails',
      })
      .expect(201);
    const order = (res.body as { id: string }).id;
    await mark(order, s.manager.token, {
      sensitive: true,
      reasonCode: 'security',
    }).expect(204);
    const kinds = async (token: string) =>
      (
        (
          await a
            .http('get', `/maintenance/assets/${assetId}/timeline`, token)
            .expect(200)
        ).body as { data: { kind: string; ticketId: string | null }[] }
      ).data.filter((e) => e.ticketId === order);
    expect(await kinds(s.supervisor.token)).toEqual([]);
    expect((await kinds(s.manager.token)).map((e) => e.kind)).toContain(
      'ticket_opened',
    );
  });

  it('clearing needs tickets.sensitive: FORBIDDEN for the supervisor; the manager clears it with a code, audited', async () => {
    const res = await mark(secret, s.supervisor.token, {
      sensitive: false,
      reasonCode: 'marked_in_error',
    }).expect(403);
    expect((res.body as Body).code).toBe('FORBIDDEN');
    await mark(secret, s.manager.token, {
      sensitive: false,
      reasonCode: 'no_longer_sensitive',
    }).expect(204);
    expect(await ids('')).toContain(secret);
    const entries = await a.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'ticket.sensitivity_changed', targetId: secret },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(
      entries.map((e) => (e.metadata as { sensitive: boolean }).sensitive),
    ).toEqual([true, false]);
  });

  it('who read it: the holders only, names and the way in', async () => {
    await a
      .http(
        'get',
        `/maintenance/tickets/${secret}/sensitive-reads`,
        s.supervisor.token,
      )
      .expect(403);
    const res = await a
      .http(
        'get',
        `/maintenance/tickets/${secret}/sensitive-reads`,
        s.manager.token,
      )
      .expect(200);
    const rows = (
      res.body as { data: { via: string; reader: { id: string } }[] }
    ).data;
    expect(rows.map((r) => r.via)).toEqual(
      expect.arrayContaining(['list', 'detail', 'export', 'search']),
    );
    expect(rows.map((r) => r.reader.id)).toContain(s.manager.id);
  });
});

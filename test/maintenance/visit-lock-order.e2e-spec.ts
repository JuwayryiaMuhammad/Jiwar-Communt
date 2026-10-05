import { Client } from 'pg';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;

/**
 * ADR 0034, the lock order: account rows (in id order), then ticket rows
 * (in id order), then visit and clock rows. One documented exception, the
 * dispatch engine (ADR 0033), locks a queued ticket and then its candidate
 * technician `FOR SHARE`; it cannot deadlock, because whoever holds a
 * technician's row exclusively (a deactivation, a freeze, an erasure, a role
 * change, an availability change) only locks the tickets in that
 * technician's hands, never a queued one, and a manual assignment's
 * `FOR SHARE` does not conflict with the engine's.
 *
 * Each case holds the first lock in a transaction of its own, starts the
 * competing request, waits until it is blocked, then takes the second lock
 * the way the real path does. A wrong order would be a deadlock (Postgres
 * aborts one side: the test sees the error); the right one finishes.
 */
describe('Maintenance — the lock order of visits, consent and the engine', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 90_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  /** A transaction of its own, in the compound, a deadlock caught fast. */
  async function holding(): Promise<Client> {
    const held = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await held.connect();
    await held.query('BEGIN');
    await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      s.c.tenantId,
    ]);
    await held.query(`SET LOCAL lock_timeout = '5s'`);
    return held;
  }

  const waitForLockWaiter = async () => {
    for (let i = 0; i < 100; i++) {
      const waiting = await db.query(
        `SELECT count(*) FROM pg_locks WHERE NOT granted`,
      );
      if (Number((waiting.rows[0] as { count: string }).count) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the request never waited on the lock');
  };

  async function member(): Promise<Who> {
    const joined = await d.x.joinFamily(s.c, s.unit.id, s.owner);
    return {
      id: joined.id,
      token: await h.tokenFor({
        sub: joined.id,
        tid: s.c.tenantId,
        typ: 'family',
      }),
    };
  }

  async function confirmedVisit() {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);
    const start = Date.now() + 60 * MINUTE;
    const res = await d
      .http('post', `/technician/tickets/${id}/visits`, s.techs[0].token, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 60 * MINUTE).toISOString(),
      })
      .expect(201);
    const visitId = (res.body as { id: string }).id;
    await d
      .http('post', `/tickets/${id}/visits/${visitId}/confirm`, s.owner.token)
      .expect(204);
    return { id, visitId };
  }

  it('the engine waits for its candidate’s deactivation in flight, which never needs the queued ticket: no deadlock', async () => {
    const tech = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    await d.specialize(s, tech, ['general']);
    await d.setAvailability(s.c, tech.id, 'available');
    // Only this technician qualifies.
    for (const other of s.techs)
      await d.setAvailability(s.c, other.id, 'unavailable');
    const queued = await d.openTicket(s);

    // The deactivation: the account row first…
    const held = await holding();
    await held.query(`UPDATE accounts SET status = 'inactive' WHERE id = $1`, [
      tech.id,
    ]);
    // …the engine locks the queued ticket and waits for the candidate…
    const pending = d
      .http(
        'post',
        `/maintenance/tickets/${queued}/auto-assign`,
        s.supervisor.token,
      )
      .then((r) => r);
    await waitForLockWaiter();
    // …the deactivation then locks the tickets in the technician's hands,
    // as the release does: never the queued one.
    await held.query(
      `SELECT id FROM tickets
        WHERE technician_account_id = $1
          AND status IN ('assigned', 'in_progress', 'on_hold')
        ORDER BY id FOR UPDATE`,
      [tech.id],
    );
    await held.query('COMMIT');
    await held.end();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'no_candidate' });
    expect((await d.ticketRow(s.c, queued)).status).toBe('new');
    for (const other of s.techs)
      await d.setAvailability(s.c, other.id, 'available');
  });

  it('a receiver is locked before the ticket: a deactivation of the receiver in flight finishes first, then the receiver is refused', async () => {
    const receiver = await member();
    const v = await confirmedVisit();
    // The deactivation holds the receiver's row…
    const held = await holding();
    await held.query(`UPDATE accounts SET status = 'inactive' WHERE id = $1`, [
      receiver.id,
    ]);
    // …the receiver write waits on it, before it locks the ticket…
    const pending = d
      .http(
        'put',
        `/tickets/${v.id}/visits/${v.visitId}/receiver`,
        s.owner.token,
        {
          accountId: receiver.id,
        },
      )
      .then((r) => r);
    await waitForLockWaiter();
    // …so the deactivation's own step on the ticket (clearing what the
    // person held) does not wait for the write: no deadlock.
    await held.query(`SELECT id FROM tickets WHERE id = $1 FOR UPDATE`, [v.id]);
    await held.query('COMMIT');
    await held.end();
    const res = await pending;
    expect(res.status).toBe(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'accountId', code: 'RECEIVER_NOT_ELIGIBLE' },
    ]);
    const row = await d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: v.visitId } }),
    );
    expect(row.receiverAccountId).toBeNull();
  });

  it('a grant waits for a change of the granter in flight, then is refused; the change never waits for the grant', async () => {
    const granter = await member();
    const v = await confirmedVisit();
    // A change of who lives where locks the person's row first…
    const held = await holding();
    await held.query(
      `SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE`,
      [granter.id],
    );
    const pending = d
      .http(
        'post',
        `/tickets/${v.id}/visits/${v.visitId}/absence-consent`,
        granter.token,
      )
      .then((r) => r);
    await waitForLockWaiter();
    // …then the tickets the person's consents are on.
    await held.query(`SELECT id FROM tickets WHERE id = $1 FOR UPDATE`, [v.id]);
    await held.query(`UPDATE accounts SET status = 'inactive' WHERE id = $1`, [
      granter.id,
    ]);
    await held.query('COMMIT');
    await held.end();
    const res = await pending;
    expect(res.status).toBe(401);
    const row = await d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: v.visitId } }),
    );
    expect(row.absenceEntryApproved).toBe(false);
  });
});

import { Client } from 'pg';
import { call } from '../api/request';
import { ticketBody } from '../api/routes/maintenance';
import { buildWorld, type World } from '../api/world';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { AUTO_CLOSE_SWEEP } from '../../src/maintenance/tickets/confirmation.service';
import { nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * The races of a ticket (ADR 0032), run for real: every outcome is one of
 * the allowed ones, and the history agrees with the row. Where a race
 * hinges on a lock, the lock is held from another connection to prove the
 * request waits on it.
 */
describe('Maintenance concurrency', () => {
  let h: HttpHarness;
  let w: World;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const ROUNDS = 5;
  const manager = () => w.a.tokens.manager;
  const code = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });

  async function newTicket(): Promise<string> {
    const res = await call(w, 'POST', '/tickets', {
      token: w.a.tokens.owner,
      body: ticketBody(w.a.homeUnitId, w.aCategoryId),
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function staff(roleKey: string) {
    const res = await call(w, 'POST', '/accounts', {
      token: manager(),
      body: {
        type: 'staff',
        roleKey,
        fullName: `Race ${Date.now()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail(roleKey),
      },
    }).expect(201);
    const id = (res.body as { id: string }).id;
    return { id, token: await w.tokenFor(w.a, id, 'staff') };
  }

  const row = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.ticket.findUniqueOrThrow({ where: { id } }),
    );
  const trail = (ticketId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.ticketAssignment.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  /** Holds a row lock in A from another connection until settled. */
  async function holding(table: string, id: string) {
    const held = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await held.connect();
    await held.query('BEGIN');
    await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      w.a.tenantId,
    ]);
    await held.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    return held;
  }
  const settle = async (held: Client, sql?: string, params: unknown[] = []) => {
    if (sql) await held.query(sql, params);
    await held.query('COMMIT');
    await held.end();
  };
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

  it('two dispatchers assign at once: one wins, one manual row', async () => {
    const supervisor = await staff('maintenance_supervisor');
    const other = await staff('technician');
    for (let i = 0; i < ROUNDS; i++) {
      const id = await newTicket();
      const results = await Promise.all([
        call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
          token: manager(),
          body: { technicianId: w.a.ids.technician },
        }),
        call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
          token: supervisor.token,
          body: { technicianId: other.id },
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      const rows = await trail(id);
      expect(rows).toHaveLength(1);
      expect((await row(id)).technicianId).toBe(rows[0].toId);
    }
  });

  it('an assignment waits for a deactivation in flight, and is then refused', async () => {
    const tech = await staff('technician');
    const id = await newTicket();
    const held = await holding('accounts', tech.id);
    const pending = call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
      token: manager(),
      body: { technicianId: tech.id },
    }).then((r) => r);
    await waitForLockWaiter();
    await settle(
      held,
      `UPDATE accounts SET status = 'inactive' WHERE id = $1`,
      [tech.id],
    );
    const res = await pending;
    expect(code(res)).toEqual({ status: 404, code: 'TECHNICIAN_NOT_FOUND' });
    expect(await row(id)).toMatchObject({ status: 'new', technicianId: null });
    expect(await trail(id)).toEqual([]);
  });

  it('a decline and a reassignment at once: one of them, never both', async () => {
    const other = await staff('technician');
    for (let i = 0; i < ROUNDS; i++) {
      const id = await newTicket();
      await call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
        token: manager(),
        body: { technicianId: w.a.ids.technician },
      }).expect(204);
      const [decline, reassign] = await Promise.all([
        call(w, 'POST', `/technician/tickets/${id}/decline`, {
          token: w.a.tokens.technician,
          body: { reasonCode: 'unavailable' },
        }),
        call(w, 'POST', `/maintenance/tickets/${id}/reassign`, {
          token: manager(),
          body: { technicianId: other.id, reasonCode: 'workload' },
        }),
      ]);
      const t = await row(id);
      const types = (await trail(id)).map((r) => r.assignmentType);
      if (decline.status === 204) {
        // The reassignment came second and found the queue.
        expect(code(reassign)).toEqual({
          status: 409,
          code: 'TICKET_INVALID_TRANSITION',
        });
        expect(t).toMatchObject({ status: 'new', technicianId: null });
        expect(types).toEqual(['manual', 'declined']);
      } else {
        expect(code(decline)).toEqual({
          status: 404,
          code: 'TICKET_NOT_FOUND',
        });
        expect(reassign.status).toBe(204);
        expect(t).toMatchObject({ status: 'assigned', technicianId: other.id });
        expect(types).toEqual(['manual', 'reassignment']);
      }
    }
  });

  /** A ticket assigned to the World's technician and started. */
  async function inProgress(): Promise<string> {
    const id = await newTicket();
    await call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
      token: manager(),
      body: { technicianId: w.a.ids.technician },
    }).expect(204);
    await call(w, 'POST', `/technician/tickets/${id}/start`, {
      token: w.a.tokens.technician,
    }).expect(204);
    return id;
  }
  const history = (ticketId: string) =>
    w.helpers.asManager(w.a, async () =>
      (
        await w.helpers.prisma.tenant.ticketStatusHistory.findMany({
          where: { ticketId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ).map((r) => r.toStatus),
    );

  it('complete and a dispatcher’s cancel at once: always cancelled, by a valid path', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await inProgress();
      const [complete, cancel] = await Promise.all([
        call(w, 'POST', `/technician/tickets/${id}/complete`, {
          token: w.a.tokens.technician,
        }),
        call(w, 'POST', `/maintenance/tickets/${id}/cancel`, {
          token: manager(),
          body: { reasonCode: 'invalid' },
        }),
      ]);
      expect(cancel.status).toBe(204);
      const t = await row(id);
      expect(t).toMatchObject({
        status: 'cancelled',
        confirmationStatus: null,
      });
      if (complete.status === 204)
        expect(await history(id)).toEqual([
          'new',
          'assigned',
          'in_progress',
          'completed',
          'cancelled',
        ]);
      else {
        expect(code(complete)).toEqual({
          status: 409,
          code: 'TICKET_INVALID_TRANSITION',
        });
        expect(await history(id)).toEqual([
          'new',
          'assigned',
          'in_progress',
          'cancelled',
        ]);
      }
    }
  });

  /** Completed long enough ago for the sweep to close it. */
  async function due(): Promise<string> {
    const id = await inProgress();
    await call(w, 'POST', `/technician/tickets/${id}/complete`, {
      token: w.a.tokens.technician,
    }).expect(204);
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.ticket.update({
        where: { id },
        data: { completedAt: new Date(Date.now() - 100 * 3_600_000) },
      }),
    );
    return id;
  }
  const autoClose = () =>
    h.moduleRef.get(SweepRunner).run(AUTO_CLOSE_SWEEP, new Date());
  const confirm = (id: string) =>
    call(w, 'POST', `/tickets/${id}/confirm`, {
      token: w.a.tokens.owner,
      body: { rating: 5 },
    });

  it('a confirmation holding the row: the sweep skips it, and the confirmation stands', async () => {
    const id = await due();
    const held = await holding('tickets', id);
    // The sweep does not wait for the lock: it leaves the row.
    await autoClose();
    await settle(held);
    expect(await row(id)).toMatchObject({ status: 'completed' });
    await confirm(id).expect(204);
    expect(await row(id)).toMatchObject({
      status: 'closed',
      confirmationStatus: 'confirmed',
    });
  });

  it('a confirmation waiting behind the sweep finds the ticket closed', async () => {
    const id = await due();
    const held = await holding('tickets', id);
    const pending = confirm(id).then((r) => r);
    await waitForLockWaiter();
    // What the sweep does, committed while the confirmation waits.
    await settle(
      held,
      `UPDATE tickets SET status = 'closed', confirmation_status = 'auto_closed',
              closed_at = now() WHERE id = $1`,
      [id],
    );
    expect(code(await pending)).toEqual({
      status: 409,
      code: 'TICKET_INVALID_TRANSITION',
    });
    expect(await row(id)).toMatchObject({ confirmationStatus: 'auto_closed' });
    const feedback = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.ticketFeedback.count({ where: { ticketId: id } }),
    );
    expect(feedback).toBe(0);
  });

  it('a confirmation and the sweep at once: exactly one of them closes it', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await due();
      const [res] = await Promise.all([confirm(id), autoClose()]);
      const t = await row(id);
      expect(t.status).toBe('closed');
      expect(t.confirmationStatus).toBe(
        res.status === 204 ? 'confirmed' : 'auto_closed',
      );
      expect((await history(id)).filter((s) => s === 'closed')).toHaveLength(1);
    }
  });

  it('a message waits for an erasure in flight on its sender, and is then refused', async () => {
    const sender = await w.helpers.resident(w.a, [w.a.homeUnitId]);
    const token = await w.tokenFor(w.a, sender.id, 'resident');
    // The sender's own ticket, so they may post on it.
    const mine = (
      (
        await call(w, 'POST', '/tickets', {
          token,
          body: ticketBody(w.a.homeUnitId, w.aCategoryId),
        }).expect(201)
      ).body as { id: string }
    ).id;
    // The erasure locks the account row first (ADR 0023).
    const held = await holding('accounts', sender.id);
    const pending = call(w, 'POST', `/tickets/${mine}/messages`, {
      token,
      body: { body: 'Sent while being erased' },
    }).then((r) => r);
    await waitForLockWaiter();
    await settle(
      held,
      `UPDATE accounts SET status = 'inactive' WHERE id = $1`,
      [sender.id],
    );
    expect((await pending).status).toBe(401);
    const bodies = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.ticketMessage.count({
        where: { ticketId: mine },
      }),
    );
    expect(bodies).toBe(0);
  });
});

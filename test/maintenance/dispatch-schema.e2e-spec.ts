import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';

/**
 * ADR 0033: what the dispatch tables refuse by themselves, whatever the
 * service says. Run as jiwar_app inside a tenant, like the app.
 */
describe('Dispatch tables — CHECKs and indexes', () => {
  let app: Client;
  const tenantId = newId();

  beforeAll(async () => {
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  });

  afterAll(() => app.end());

  /** Runs `sql` in a transaction that is always rolled back. */
  async function attempt(sql: string, params: unknown[] = []) {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      return await app.query(sql, params);
    } finally {
      await app.query('ROLLBACK');
    }
  }

  const history = (
    from: string | null,
    to: string,
    actor: string | null,
    account: string,
    reason: string | null,
  ) =>
    attempt(
      `INSERT INTO technician_availability_history
         (id, tenant_id, account_id, from_state, to_state, changed_by_account_id, reason_code)
       VALUES ($1, $2, $3, $4::technician_availability_state,
               $5::technician_availability_state, $6, $7)`,
      [newId(), tenantId, account, from, to, actor, reason],
    );

  describe('technician_availability_history', () => {
    const tech = newId();

    it('the technician changes their own state without a reason', async () => {
      await expect(
        history(null, 'available', tech, tech, null),
      ).resolves.toBeDefined();
    });

    it('a dispatcher needs a reason code', async () => {
      await expect(
        history(null, 'unavailable', newId(), tech, null),
      ).rejects.toThrow(/reason_shape/);
      await expect(
        history(null, 'unavailable', newId(), tech, 'sick'),
      ).resolves.toBeDefined();
    });

    it('the system (a NULL actor) needs a reason code: the NULL trap', async () => {
      await expect(
        history(null, 'unavailable', null, tech, null),
      ).rejects.toThrow(/reason_shape/);
      await expect(
        history(null, 'unavailable', null, tech, 'account_deactivated'),
      ).resolves.toBeDefined();
    });

    it('a change always changes something', async () => {
      await expect(
        history('available', 'available', tech, tech, null),
      ).rejects.toThrow(/from_shape/);
    });
  });

  describe('ticket_dispatch_attempts', () => {
    const ticket = newId();
    const insert = (
      outcome: string,
      count: number,
      technician: string | null,
      reason: string | null,
      notified = false,
      cycle = 1,
    ) =>
      app.query(
        `INSERT INTO ticket_dispatch_attempts
           (id, tenant_id, ticket_id, cycle, trigger, outcome, candidate_count,
            technician_account_id, reason_code, notified)
         VALUES ($1, $2, $3, $4, 'sweep', $5::dispatch_outcome, $6, $7, $8, $9)`,
        [
          newId(),
          tenantId,
          ticket,
          cycle,
          outcome,
          count,
          technician,
          reason,
          notified,
        ],
      );

    async function inTx(fn: () => Promise<unknown>) {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        return await fn();
      } finally {
        await app.query('ROLLBACK');
      }
    }

    it('an assignment names a technician and had a candidate', async () => {
      await inTx(async () => {
        await insert('assigned', 2, newId(), null);
        await app.query('SAVEPOINT s');
        await expect(insert('assigned', 2, null, null)).rejects.toThrow(
          /shape/,
        );
        await app.query('ROLLBACK TO s');
        await expect(insert('assigned', 0, newId(), null)).rejects.toThrow(
          /shape/,
        );
      });
    });

    it('no_candidate has no technician and no candidates', async () => {
      await inTx(async () => {
        await insert('no_candidate', 0, null, null);
        await app.query('SAVEPOINT s');
        await expect(insert('no_candidate', 1, null, null)).rejects.toThrow(
          /shape/,
        );
        await app.query('ROLLBACK TO s');
        await expect(insert('no_candidate', 0, newId(), null)).rejects.toThrow(
          /shape/,
        );
      });
    });

    it('skipped carries its reason, and nothing else does', async () => {
      await inTx(async () => {
        await insert('skipped', 0, null, 'auto_dispatch_disabled');
        await app.query('SAVEPOINT s');
        await expect(insert('skipped', 0, null, null)).rejects.toThrow(/shape/);
        await app.query('ROLLBACK TO s');
        await expect(
          insert('no_candidate', 0, null, 'auto_dispatch_disabled'),
        ).rejects.toThrow(/shape/);
      });
    });

    it('only a no_candidate row can be the notified one', async () => {
      await inTx(async () => {
        await expect(
          insert('skipped', 0, null, 'auto_dispatch_disabled', true),
        ).rejects.toThrow(/shape/);
      });
    });

    it('at most one notified row per ticket and cycle', async () => {
      await inTx(async () => {
        await insert('no_candidate', 0, null, null, true, 1);
        await app.query('SAVEPOINT s');
        await expect(
          insert('no_candidate', 0, null, null, true, 1),
        ).rejects.toThrow(/one_notice_per_cycle/);
        await app.query('ROLLBACK TO s');
        // Other rows of the cycle, and the next cycle, are fine.
        await insert('no_candidate', 0, null, null, false, 1);
        await insert('no_candidate', 0, null, null, true, 2);
      });
    });
  });
});

import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  appealRow,
  approvalRequestRow,
  boardMemberRow,
  boardTermRow,
  motionRow,
} from '../setup/governance-rows';

/**
 * The board matters' tables (ADR 0055) at the database: what the app may
 * write, what the triggers keep (a package never changes, a request moves
 * forward once, a motion closes once, a vote is cast once while its motion
 * is open), and what holds at commit: a request is decided exactly by one
 * carried motion with its outcome.
 */
describe('Board matters’ tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let accountId: string;
  let termId: string;
  let memberId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Board matters schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    await inTx(async (tx) => {
      termId = await boardTermRow(tx, {
        tenantId,
        createdById: accountId,
        open: true,
      });
      memberId = await boardMemberRow(tx, {
        tenantId,
        termId,
        accountId,
        addedById: accountId,
      });
    });
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  }, 120_000);

  afterAll(async () => {
    await app.end();
    await h.close();
  });

  /** The statements in one transaction as the app, rolled back; deferred checks forced. */
  async function asApp(...statements: string[]) {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await app.query(sql);
      await app.query('SET CONSTRAINTS ALL IMMEDIATE');
      return last;
    } finally {
      await app.query('ROLLBACK');
    }
  }
  const privileges = async (table: string) => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, 'SELECT') AS select,
              has_table_privilege($1, 'INSERT') AS insert,
              has_table_privilege($1, 'UPDATE') AS update,
              has_table_privilege($1, 'DELETE') AS delete,
              has_table_privilege($1, 'TRUNCATE') AS truncate`,
      [table],
    );
    return rows[0];
  };
  let n = 100;
  /** A pending request and an open motion on it, committed. */
  async function requestWithMotion() {
    return inTx(async (tx) => {
      const requestId = await approvalRequestRow(tx, {
        tenantId,
        raisedById: accountId,
        number: n++,
      });
      const motionId = await motionRow(tx, {
        tenantId,
        requestId,
        termId,
        memberId,
        accountId,
      });
      return { requestId, motionId };
    });
  }
  const carry = (motionId: string) =>
    `UPDATE board_motions SET closed_at = now(), result = 'carried', closed_by_account_id = '${accountId}',
       votes_for = 1, votes_against = 0, sitting = 1 WHERE id = '${motionId}'`;
  const decide = (requestId: string, motionId: string, status = 'approved') =>
    `UPDATE governance_approval_requests SET status = '${status}', decided_at = now(),
       decided_motion_id = '${motionId}' WHERE id = '${requestId}'`;

  it('the app writes what each table needs and nothing more; nothing is truncated', async () => {
    const write = { select: true, insert: true, update: true, delete: false };
    const append = { select: true, insert: true, update: false, delete: false };
    const expected: Record<string, Record<string, boolean>> = {
      governance_approval_settings: write,
      governance_approval_requests: write,
      governance_approval_alternatives: append,
      governance_approval_attachments: append,
      board_motions: write,
      board_votes: append,
      governance_board_appeals: write,
      governance_board_appeal_attachments: append,
      board_motion_recusals: append,
    };
    for (const [table, p] of Object.entries(expected))
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        ...p,
        truncate: false,
      });
  });

  it('a package never changes; a request moves forward from pending once', async () => {
    const { requestId, motionId } = await requestWithMotion();
    await expect(
      asApp(
        `UPDATE governance_approval_requests SET context = 'Other' WHERE id = '${requestId}'`,
      ),
    ).rejects.toThrow(/the package is kept/);
    await expect(
      asApp(
        `UPDATE governance_approval_requests SET withdrawn_at = now(), withdrawn_by_account_id = '${accountId}',
           withdraw_reason_code = 'other', status = 'withdrawn' WHERE id = '${requestId}'`,
        `UPDATE governance_approval_requests SET withdraw_reason_code = 'superseded' WHERE id = '${requestId}'`,
      ),
    ).rejects.toThrow(/moves forward once/);
    await expect(
      asApp(
        carry(motionId),
        decide(requestId, motionId),
        `UPDATE governance_approval_requests SET status = 'rejected' WHERE id = '${requestId}'`,
      ),
    ).rejects.toThrow(/moves forward once|state_shape|decided/);
  });

  it('at commit: decided exactly by a carried motion with its outcome; a carried motion decides its request', async () => {
    const one = await requestWithMotion();
    // Decided without a carried motion.
    await expect(asApp(decide(one.requestId, one.motionId))).rejects.toThrow(
      /exactly by one carried motion/,
    );
    // A carried motion leaving the request pending.
    await expect(asApp(carry(one.motionId))).rejects.toThrow(
      /exactly by one carried motion/,
    );
    // Approved by a motion to reject.
    await expect(
      asApp(
        `UPDATE board_motions SET outcome = 'reject' WHERE id = '${one.motionId}'`,
      ),
    ).rejects.toThrow(/keeps what was proposed/);
    await expect(
      asApp(
        carry(one.motionId),
        decide(one.requestId, one.motionId, 'rejected'),
      ),
    ).rejects.toThrow(/exactly by one carried motion/);
    // Both together: fine.
    await asApp(carry(one.motionId), decide(one.requestId, one.motionId));
  });

  it('a motion keeps what was proposed and closes once, its count with a count only', async () => {
    const { motionId } = await requestWithMotion();
    await expect(
      asApp(
        `UPDATE board_motions SET rationale = 'Other' WHERE id = '${motionId}'`,
      ),
    ).rejects.toThrow(/keeps what was proposed/);
    // Open with a count: the CHECK (no NULL trap on an open motion).
    await expect(
      asApp(`UPDATE board_motions SET votes_for = 1 WHERE id = '${motionId}'`),
    ).rejects.toThrow(/board_motions_close_shape/);
    // A lapse names nobody; a withdrawal names who.
    await expect(
      asApp(
        `UPDATE board_motions SET closed_at = now(), result = 'lapsed', closed_by_account_id = '${accountId}' WHERE id = '${motionId}'`,
      ),
    ).rejects.toThrow(/board_motions_close_shape/);
    await expect(
      asApp(
        `UPDATE board_motions SET closed_at = now(), result = 'withdrawn', closed_by_account_id = '${accountId}' WHERE id = '${motionId}'`,
        `UPDATE board_motions SET result = 'lapsed', closed_by_account_id = NULL WHERE id = '${motionId}'`,
      ),
    ).rejects.toThrow(/closes once/);
    await expect(
      asApp(`DELETE FROM board_motions WHERE id = '${motionId}'`),
    ).rejects.toThrow(/permission denied|closes once/);
  });

  it('one open motion per request', async () => {
    const { requestId } = await requestWithMotion();
    await expect(
      inTx((tx) =>
        motionRow(tx, { tenantId, requestId, termId, memberId, accountId }),
      ),
    ).rejects.toThrow(/board_motions_one_open_per_request/);
  });

  it('a vote once, while its motion is open, never changed', async () => {
    const { motionId } = await requestWithMotion();
    const cast = (id = 'gen_random_uuid()') =>
      `INSERT INTO board_votes (id, tenant_id, motion_id, member_id, account_id, choice, cast_at)
         VALUES (${id}, '${tenantId}', '${motionId}', '${memberId}', '${accountId}', 'for', now())`;
    await expect(asApp(cast(), cast())).rejects.toThrow(/board_votes_once/);
    await expect(
      asApp(
        `UPDATE board_motions SET closed_at = now(), result = 'withdrawn', closed_by_account_id = '${accountId}' WHERE id = '${motionId}'`,
        cast(),
      ),
    ).rejects.toThrow(/is closed/);
    await asApp(cast());
    await expect(
      asApp(
        cast(),
        `UPDATE board_votes SET choice = 'against' WHERE motion_id = '${motionId}'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('one pending request per subject; the type names its subject', async () => {
    const subject = '0193b8a4-1111-7000-8000-000000000001';
    const insert = (number: number, type = 'budget_increase') =>
      `INSERT INTO governance_approval_requests (id, tenant_id, number, type, subject_id, raised_by_account_id,
         context, impact, cost, deadline_at, created_at)
       VALUES (gen_random_uuid(), '${tenantId}', ${number}, '${type}', '${subject}', '${accountId}',
         'c', 'i', 10, now() + interval '1 day', now())`;
    await expect(asApp(insert(8001), insert(8002))).rejects.toThrow(
      /governance_approval_requests_one_pending/,
    );
    await expect(asApp(insert(8003, 'major_contract'))).rejects.toThrow(
      /governance_approval_requests_subject/,
    );
  });

  it('the settings: a threshold only for its four types; a row is never deleted', async () => {
    await expect(
      asApp(
        `INSERT INTO governance_approval_settings (tenant_id, type, deadline_days, threshold)
           VALUES ('${tenantId}', 'legal_escalation', 14, 10)`,
      ),
    ).rejects.toThrow(/governance_approval_settings_threshold/);
    await expect(
      asApp(
        `DELETE FROM governance_approval_settings WHERE type = 'major_contract'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  describe('appeals (ADR 0055)', () => {
    let unitId: string;
    beforeAll(async () => {
      unitId = (await createUnit(h, tenantId)).id;
    });
    const appeal = () =>
      inTx((tx) =>
        appealRow(tx, {
          tenantId,
          unitId,
          appellantId: accountId,
          number: n++,
        }),
      );
    const motionOn = (appealId: string) =>
      `INSERT INTO board_motions (id, tenant_id, board_appeal_id, term_id, proposed_by_member_id,
         proposed_by_account_id, outcome, rationale, opened_at)
       VALUES (gen_random_uuid(), '${tenantId}', '${appealId}', '${termId}', '${memberId}',
         '${accountId}', 'overturn', 'r', now())`;

    it('an appeal is kept as lodged; its grounds are cleared once; it moves from pending once', async () => {
      const id = await appeal();
      await expect(
        asApp(
          `UPDATE governance_board_appeals SET kind = 'vehicle_fine' WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/kept as lodged/);
      await asApp(
        `UPDATE governance_board_appeals SET grounds = NULL, grounds_cleared_at = now() WHERE id = '${id}'`,
      );
      await expect(
        asApp(
          `UPDATE governance_board_appeals SET status = 'withdrawn', withdrawn_at = now(), effect = 'none' WHERE id = '${id}'`,
          `UPDATE governance_board_appeals SET status = 'pending', withdrawn_at = NULL, effect = NULL WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/moves forward once/);
      // A follow-up only of an overturn left to the management.
      await expect(
        asApp(
          `UPDATE governance_board_appeals SET status = 'withdrawn', withdrawn_at = now(), effect = 'follow_up' WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/governance_board_appeals_state_shape/);
    });

    it('one appeal per decision, ever', async () => {
      const id = await appeal();
      await expect(
        asApp(
          `INSERT INTO governance_board_appeals (id, tenant_id, number, kind, subject_id, unit_id,
             appellant_account_id, grounds, decision_at, lodged_at, deadline_at)
           SELECT gen_random_uuid(), tenant_id, number + 1, kind, subject_id, unit_id,
             appellant_account_id, 'again', decision_at, lodged_at, deadline_at
             FROM governance_board_appeals WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/governance_board_appeals_one_per_decision/);
    });

    it('a motion names one matter, with an appeal’s outcomes; at commit an appeal is decided only by it', async () => {
      const id = await appeal();
      await expect(
        asApp(motionOn(id).replace("'overturn'", "'approve'")),
      ).rejects.toThrow(/board_motions_outcome/);
      await expect(
        asApp(
          `UPDATE governance_board_appeals SET status = 'upheld', decided_at = now(),
             decided_motion_id = (SELECT id FROM board_motions LIMIT 1), effect = 'none' WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/exactly by one carried motion|foreign key/);
    });

    it('recusals are written when a motion opens, before any vote, and never change', async () => {
      const id = await appeal();
      await inTx(async (tx) => {
        await tx.$executeRawUnsafe(motionOn(id));
      });
      const [{ id: motionId }] = await inTx(
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM board_motions WHERE board_appeal_id = ${id}::uuid`,
      );
      const recuse = `INSERT INTO board_motion_recusals (tenant_id, motion_id, account_id)
                      VALUES ('${tenantId}', '${motionId}', '${accountId}')`;
      await asApp(recuse);
      await expect(
        asApp(
          `INSERT INTO board_votes (id, tenant_id, motion_id, member_id, account_id, choice, cast_at)
             VALUES (gen_random_uuid(), '${tenantId}', '${motionId}', '${memberId}', '${accountId}', 'for', now())`,
          recuse,
        ),
      ).rejects.toThrow(/before any vote/);
      await expect(
        asApp(
          recuse,
          `DELETE FROM board_motion_recusals WHERE motion_id = '${motionId}'`,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});

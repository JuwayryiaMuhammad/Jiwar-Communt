import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  boardMemberRow,
  boardTermRow,
  representativeMatterRow,
  representativeRow,
} from '../setup/governance-rows';

/**
 * A representative matter (ADR 0059) at the database: the app may write it
 * and move it, never delete it; it moves from pending once; it is decided
 * exactly by one carried motion with its outcome (at commit); an approval
 * says whether it applied; motions on it approve or reject; a term names
 * the matter that named it, and one that ended it.
 */
describe('Representative matters — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let accountId: string;
  let unitId: string;
  let termId: string;
  let memberId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Representative matters schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
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
  let n = 0;
  /** A pending appointment of a building of its own, committed. */
  const pending = () =>
    inTx((tx) =>
      representativeMatterRow(tx, {
        tenantId,
        building: `S-${n++}`,
        accountId,
        raisedById: accountId,
      }),
    );
  const motion = (matterId: string, outcome = 'approve', id = newId()) =>
    `INSERT INTO board_motions (id, tenant_id, representative_matter_id, term_id, proposed_by_member_id,
       proposed_by_account_id, outcome, rationale, opened_at)
     VALUES ('${id}', '${tenantId}', '${matterId}', '${termId}', '${memberId}', '${accountId}',
       '${outcome}', 'A row', now())`;
  const carry = (motionId: string) =>
    `UPDATE board_motions SET closed_at = now(), result = 'carried', closed_by_account_id = '${accountId}',
       votes_for = 1, votes_against = 0, sitting = 1 WHERE id = '${motionId}'`;
  const decide = (
    matterId: string,
    motionId: string,
    status = 'approved',
    effect = "'applied'",
  ) =>
    `UPDATE governance_representative_matters SET status = '${status}', decided_at = now(),
       decided_motion_id = '${motionId}', effect = ${effect} WHERE id = '${matterId}'`;

  it('the app writes and moves a matter, never deletes or truncates it', async () => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege('governance_representative_matters', 'SELECT') AS select,
              has_table_privilege('governance_representative_matters', 'INSERT') AS insert,
              has_table_privilege('governance_representative_matters', 'UPDATE') AS update,
              has_table_privilege('governance_representative_matters', 'DELETE') AS delete,
              has_table_privilege('governance_representative_matters', 'TRUNCATE') AS truncate`,
    );
    expect(rows[0]).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
      truncate: false,
    });
  });

  it('decided exactly by a carried motion with its outcome, at commit', async () => {
    const id = await pending();
    const m = newId();
    // Approved with no carried motion: refused at commit.
    await expect(
      asApp(motion(id, 'approve', m), decide(id, m)),
    ).rejects.toThrow(/decided \(approved\) exactly by one carried motion/);
    // A carried rejection does not approve it.
    const r = newId();
    await expect(
      asApp(motion(id, 'reject', r), carry(r), decide(id, r)),
    ).rejects.toThrow(/exactly by one carried motion/);
    // A carried motion leaves no matter pending.
    const p = newId();
    await expect(asApp(motion(id, 'approve', p), carry(p))).rejects.toThrow(
      /decided \(pending\)/,
    );
    const ok = newId();
    await expect(
      asApp(motion(id, 'approve', ok), carry(ok), decide(id, ok)),
    ).resolves.toBeDefined();
    await expect(
      asApp(
        motion(id, 'reject', ok),
        carry(ok),
        decide(id, ok, 'rejected', 'NULL'),
      ),
    ).resolves.toBeDefined();
  });

  it('a motion on it approves or rejects, with no alternatives', async () => {
    const id = await pending();
    await expect(asApp(motion(id, 'uphold'))).rejects.toThrow(
      /board_motions_outcome/,
    );
    await expect(
      asApp(
        `INSERT INTO board_motions (id, tenant_id, representative_matter_id, term_id, proposed_by_member_id,
           proposed_by_account_id, outcome, rationale, alternatives_note, opened_at)
         VALUES ('${newId()}', '${tenantId}', '${id}', '${termId}', '${memberId}', '${accountId}',
           'approve', 'A row', 'A note', now())`,
      ),
    ).rejects.toThrow(/board_motions_texts/);
  });

  it('an approval says whether it applied, and why not by its action', async () => {
    const id = await pending();
    const m = newId();
    const approved = (effect: string, reason: string) =>
      asApp(
        motion(id, 'approve', m),
        carry(m),
        `UPDATE governance_representative_matters SET status = 'approved', decided_at = now(),
           decided_motion_id = '${m}', effect = ${effect}, effect_reason = ${reason}
         WHERE id = '${id}'`,
      );
    await expect(approved('NULL', 'NULL')).rejects.toThrow(
      /governance_representative_matters_state_shape/,
    );
    await expect(approved("'not_applied'", 'NULL')).rejects.toThrow(
      /governance_representative_matters_effect/,
    );
    // An appointment never ends a term already ended.
    await expect(approved("'not_applied'", "'already_ended'")).rejects.toThrow(
      /governance_representative_matters_effect/,
    );
    await expect(approved("'applied'", "'not_an_owner'")).rejects.toThrow(
      /governance_representative_matters_effect/,
    );
    await expect(
      approved("'not_applied'", "'not_an_owner'"),
    ).resolves.toBeDefined();
  });

  it('it moves from pending once, never deleted; an end names its term', async () => {
    const id = await pending();
    await expect(
      asApp(
        `UPDATE governance_representative_matters SET status = 'withdrawn', withdrawn_at = now(),
           withdrawn_by_account_id = '${accountId}' WHERE id = '${id}'`,
        `UPDATE governance_representative_matters SET building = 'Moved' WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/moves from pending once/);
    await expect(
      asApp(
        `UPDATE governance_representative_matters SET building = 'Moved' WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/moves from pending once/);
    await expect(
      asApp(`DELETE FROM governance_representative_matters WHERE id = '${id}'`),
    ).rejects.toThrow(/permission denied|moves from pending once/);
    await expect(
      asApp(
        `INSERT INTO governance_representative_matters (id, tenant_id, action, building, account_id,
           raised_by_account_id, raised_at, deadline_at)
         VALUES ('${newId()}', '${tenantId}', 'end', 'E', '${accountId}', '${accountId}', now(),
           now() + interval '1 day')`,
      ),
    ).rejects.toThrow(/governance_representative_matters_action/);
  });

  it('one pending per building; a term records the matter that ended it', async () => {
    const id = await pending();
    const building = (
      await inTx((tx) =>
        tx.governanceRepresentativeMatter.findUniqueOrThrow({
          where: { id },
        }),
      )
    ).building;
    await expect(
      asApp(
        `INSERT INTO governance_representative_matters (id, tenant_id, action, building, account_id,
           raised_by_account_id, raised_at, deadline_at)
         VALUES ('${newId()}', '${tenantId}', 'appoint', '${building}', '${accountId}',
           '${accountId}', now(), now() + interval '1 day')`,
      ),
    ).rejects.toThrow(/governance_representative_matters_one_pending/);
    const rep = await inTx((tx) =>
      representativeRow(tx, {
        tenantId,
        building: `R-${n++}`,
        unitId,
        accountId,
        appointedById: accountId,
      }),
    );
    // `ended` names the matter; the system's reasons name none.
    await expect(
      asApp(
        `UPDATE governance_representatives SET ended_at = now(), end_reason = 'ended'
          WHERE id = '${rep}'`,
      ),
    ).rejects.toThrow(/governance_representatives_end_shape/);
    await expect(
      asApp(
        `UPDATE governance_representatives SET ended_at = now(), end_reason = 'no_longer_owner',
           ended_by_matter_id = '${id}' WHERE id = '${rep}'`,
      ),
    ).rejects.toThrow(/governance_representatives_end_shape/);
    await expect(
      asApp(
        `UPDATE governance_representatives SET ended_at = now(), end_reason = 'ended',
           ended_by_matter_id = '${id}' WHERE id = '${rep}'`,
      ),
    ).resolves.toBeDefined();
  });
});

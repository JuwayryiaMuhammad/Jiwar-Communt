import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  boardMemberRow,
  boardTermRow,
  closedContestRows,
  contestRow,
  openContest,
} from '../setup/governance-rows';
import { required } from '../setup/test-env';

/**
 * The governance tables (ADR 0051) at the database: what the app may
 * write, what the triggers keep, and the shapes the CHECKs hold whatever
 * the services do — above all that a secret vote is never stored next to
 * its unit, never changed, and that every participation has its ballot.
 */
describe('Governance tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let otherAccountId: string;
  let unitId: string;
  let otherUnitId: string;
  let termId: string;
  let memberId: string;
  /** Open, secret, with two electors (unitId → accountId, otherUnitId → otherAccountId). */
  let secretId: string;
  /** Open, not secret, the same electors. */
  let openId: string;
  /** Not opened yet. */
  let draftId: string;

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Governance schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    otherAccountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    otherUnitId = (await createUnit(h, tenantId)).id;
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
      const electors = [
        { unitId, accountId },
        { unitId: otherUnitId, accountId: otherAccountId },
      ];
      secretId = await contestRow(tx, { tenantId });
      await openContest(tx, { tenantId, contestId: secretId, electors });
      openId = await contestRow(tx, { tenantId, secret: false });
      await openContest(tx, { tenantId, contestId: openId, electors });
      draftId = await contestRow(tx, { tenantId });
    });
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();
  }, 120_000);

  afterAll(async () => {
    await app.end();
    await migrator.end();
    await h.close();
  });

  /** The statements in one transaction, rolled back; deferred checks forced. */
  async function attempt(client: Client, ...statements: string[]) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await client.query(sql);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      return last;
    } finally {
      await client.query('ROLLBACK');
    }
  }
  const asApp = (...statements: string[]) => attempt(app, ...statements);
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
  const vote = (
    contest: string,
    unit: string,
    voter: string,
    secret: boolean,
    choice: string | null,
  ) =>
    `INSERT INTO governance_participations (tenant_id, contest_id, unit_id, voter_account_id, voted_at, secret, choice)
       VALUES ('${tenantId}', '${contest}', '${unit}', '${voter}', now(), ${secret}, ${choice ? `ARRAY['${choice}']::uuid[]` : 'NULL'})`;
  const addBallot = (contest: string, key = 'gen_random_uuid()::text') =>
    `UPDATE governance_ballot_boxes
        SET ballots = ballots || jsonb_build_object(${key}, jsonb_build_array(gen_random_uuid()))
      WHERE contest_id = '${contest}'`;
  const CHOICE = '0192f1c2-7a4b-4c3d-8e9f-0a1b2c3d4e5f';

  it('the app writes what each table needs and nothing more; nothing is truncated', async () => {
    const expected: Record<string, Record<string, boolean>> = {
      board_terms: { select: true, insert: true, update: true, delete: false },
      board_members: {
        select: true,
        insert: true,
        update: true,
        delete: false,
      },
      governance_contests: {
        select: true,
        insert: true,
        update: true,
        delete: false,
      },
      governance_electors: {
        select: true,
        insert: true,
        update: false,
        delete: false,
      },
      governance_participations: {
        select: true,
        insert: true,
        update: false,
        delete: false,
      },
      governance_ballot_boxes: {
        select: true,
        insert: true,
        update: true,
        delete: true,
      },
      governance_ballots: {
        select: true,
        insert: true,
        update: false,
        delete: false,
      },
    };
    for (const [table, p] of Object.entries(expected))
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        ...p,
        truncate: false,
      });
  });

  describe('the board', () => {
    it('one open term per compound', async () => {
      await expect(
        inTx((tx) =>
          boardTermRow(tx, { tenantId, createdById: accountId, open: true }),
        ),
      ).rejects.toThrow(/board_terms_one_open/);
    });

    it('a term only ends, once; nothing else of it changes', async () => {
      await expect(
        attempt(
          migrator,
          `UPDATE board_terms SET seats = 9 WHERE id = '${termId}'`,
        ),
      ).rejects.toThrow(/a term only ends/);
      await expect(
        attempt(
          migrator,
          `UPDATE board_terms SET ended_at = now(), end_reason = 'succeeded' WHERE id = '${termId}'`,
          `UPDATE board_terms SET end_reason = 'replaced' WHERE id = '${termId}'`,
        ),
      ).rejects.toThrow(/a term only ends/);
      await expect(
        attempt(migrator, `DELETE FROM board_terms WHERE id = '${termId}'`),
      ).rejects.toThrow(/a term only ends/);
      await expect(
        asApp(`UPDATE board_terms SET ended_at = now() WHERE id = '${termId}'`),
      ).rejects.toThrow(/board_terms_end_shape/);
    });

    it('a seat’s holder never changes, its role only while seated, its end once', async () => {
      await expect(
        attempt(
          migrator,
          `UPDATE board_members SET account_id = '${otherAccountId}' WHERE id = '${memberId}'`,
        ),
      ).rejects.toThrow(/only a seated member/);
      await asApp(
        `UPDATE board_members SET role = 'chair' WHERE id = '${memberId}'`,
      );
      await expect(
        asApp(
          `UPDATE board_members SET ended_at = now(), end_reason = 'resigned' WHERE id = '${memberId}'`,
          `UPDATE board_members SET role = 'chair' WHERE id = '${memberId}'`,
        ),
      ).rejects.toThrow(/only a seated member/);
      await expect(
        asApp(
          `UPDATE board_members SET ended_at = now(), end_reason = 'promoted' WHERE id = '${memberId}'`,
        ),
      ).rejects.toThrow(/board_members_end_reason/);
    });

    it('one seat per account in a term, one holder of an office', async () => {
      const seat = (account: string, role: string) =>
        `INSERT INTO board_members (id, tenant_id, term_id, account_id, role, added_at, added_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', '${termId}', '${account}', '${role}', now(), '${accountId}')`;
      await expect(asApp(seat(accountId, 'member'))).rejects.toThrow(
        /board_members_one_seat/,
      );
      await expect(
        asApp(
          seat(otherAccountId, 'treasurer'),
          `UPDATE board_members SET role = 'treasurer' WHERE id = '${memberId}'`,
        ),
      ).rejects.toThrow(/board_members_one_office/);
    });
  });

  it('an announcement is of kind `board` exactly when a board publication names it', async () => {
    const insert = (id: string) =>
      `INSERT INTO announcements (id, tenant_id, kind, publish_at, audience_occupancy, created_by_account_id, updated_at)
         VALUES ('${id}', '${tenantId}', 'board', now(), 'owners', '${accountId}', now())`;
    await expect(
      asApp(insert('0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e51')),
    ).rejects.toThrow(/exactly when a board publication names it/);
    await expect(
      asApp(
        `INSERT INTO announcements (id, tenant_id, kind, publish_at, audience_occupancy, created_by_account_id, updated_at)
           VALUES ('0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e52', '${tenantId}', 'general', now(), 'owners', '${accountId}', now())`,
        `INSERT INTO board_publications (id, tenant_id, kind, term_id, announcement_id, decided_on, author_side, published_by_account_id)
           VALUES (gen_random_uuid(), '${tenantId}', 'decision', '${termId}', '0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e52', current_date, 'manager', '${accountId}')`,
      ),
    ).rejects.toThrow(/exactly when a board publication names it/);
  });

  describe('a contest', () => {
    it('never changes its kind, secrecy or choices; its window only before it opens', async () => {
      for (const set of [
        'secret = false',
        "kind = 'election'",
        'max_choices = 2',
      ])
        await expect(
          asApp(
            `UPDATE governance_contests SET ${set} WHERE id = '${draftId}'`,
          ),
        ).rejects.toThrow(/only opens, closes or is cancelled/);
      await asApp(
        `UPDATE governance_contests SET closes_at = closes_at + interval '1 day' WHERE id = '${draftId}'`,
      );
      await expect(
        asApp(
          `UPDATE governance_contests SET closes_at = closes_at + interval '1 day' WHERE id = '${secretId}'`,
        ),
      ).rejects.toThrow(/only opens, closes or is cancelled/);
      await expect(
        asApp(
          `UPDATE governance_contests SET cancelled_at = now() WHERE id = '${secretId}'`,
          `UPDATE governance_contests SET cancelled_at = now() + interval '1 second' WHERE id = '${secretId}'`,
        ),
      ).rejects.toThrow(/only opens, closes or is cancelled/);
    });

    it('an election is secret', async () => {
      await expect(
        inTx((tx) =>
          contestRow(tx, { tenantId, kind: 'election', secret: false }),
        ),
      ).rejects.toThrow(/governance_contests_election_secret/);
    });

    it('its electorate is fixed once it opened', async () => {
      const extra = await createUnit(h, tenantId);
      await expect(
        asApp(
          `INSERT INTO governance_electors (tenant_id, contest_id, unit_id, account_id)
             VALUES ('${tenantId}', '${secretId}', '${extra.id}', '${accountId}')`,
        ),
      ).rejects.toThrow(/electorate is fixed/);
    });
  });

  describe('a vote', () => {
    it('a secret one never stores the choice next to the unit; an open one always does', async () => {
      await expect(
        asApp(vote(secretId, unitId, accountId, true, CHOICE)),
      ).rejects.toThrow(/governance_participations_choice_shape/);
      // Claiming the contest is not secret: the composite key refuses it.
      await expect(
        asApp(vote(secretId, unitId, accountId, false, CHOICE)),
      ).rejects.toThrow(/governance_participations_contest_fkey/);
      await expect(
        asApp(vote(openId, unitId, accountId, false, null)),
      ).rejects.toThrow(/governance_participations_choice_shape/);
      await asApp(vote(openId, unitId, accountId, false, CHOICE));
    });

    it('a unit votes once, by its elector, while the contest is open', async () => {
      await expect(
        asApp(
          vote(openId, unitId, accountId, false, CHOICE),
          vote(openId, unitId, accountId, false, CHOICE),
        ),
      ).rejects.toThrow(/governance_participations_pkey/);
      await expect(
        asApp(vote(openId, unitId, otherAccountId, false, CHOICE)),
      ).rejects.toThrow(/by its elector/);
      const stranger = await createUnit(h, tenantId);
      await expect(
        asApp(vote(openId, stranger.id, accountId, false, CHOICE)),
      ).rejects.toThrow(/by its elector/);
      await expect(
        asApp(vote(draftId, unitId, accountId, true, null)),
      ).rejects.toThrow(/by its elector/);
      await expect(
        asApp(
          `UPDATE governance_contests SET closed_at = now(), turnout = 0 WHERE id = '${openId}'`,
          vote(openId, unitId, accountId, false, CHOICE),
        ),
      ).rejects.toThrow(/while the contest is open/);
    });

    it('no vote is ever changed or withdrawn', async () => {
      await expect(
        asApp(
          vote(openId, unitId, accountId, false, CHOICE),
          `UPDATE governance_participations SET choice = ARRAY[gen_random_uuid()] WHERE contest_id = '${openId}'`,
        ),
      ).rejects.toThrow(/append-only|permission denied/);
      await expect(
        attempt(
          migrator,
          vote(openId, unitId, accountId, false, CHOICE),
          `DELETE FROM governance_participations WHERE contest_id = '${openId}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('the secret ballot box', () => {
    it('takes a ballot with its participation; one without the other fails at commit', async () => {
      await asApp(
        vote(secretId, unitId, accountId, true, null),
        addBallot(secretId),
      );
      await expect(
        asApp(vote(secretId, unitId, accountId, true, null)),
      ).rejects.toThrow(/1 participations, 0 ballots in a box/);
      await expect(asApp(addBallot(secretId))).rejects.toThrow(
        /0 participations, 1 ballots in a box/,
      );
    });

    it('never changes or loses a ballot already cast', async () => {
      const key = `'0192f1c2-7a4b-4c3d-8e9f-0a1b2c3d4e50'`;
      const cast = [
        vote(secretId, unitId, accountId, true, null),
        addBallot(secretId, key),
      ];
      await expect(
        asApp(
          ...cast,
          `UPDATE governance_ballot_boxes SET ballots = ballots || jsonb_build_object(${key}, jsonb_build_array(gen_random_uuid())) WHERE contest_id = '${secretId}'`,
        ),
      ).rejects.toThrow(/only added while the contest is open/);
      await expect(
        asApp(
          ...cast,
          `UPDATE governance_ballot_boxes SET ballots = '{}' WHERE contest_id = '${secretId}'`,
        ),
      ).rejects.toThrow(/only added while the contest is open/);
      await expect(
        asApp(
          `DELETE FROM governance_ballot_boxes WHERE contest_id = '${secretId}'`,
        ),
      ).rejects.toThrow(/the box goes at its end/);
    });

    it('a ballot row is written at the close only, with a random v4 id, and never changed', async () => {
      const row = (id = 'gen_random_uuid()') =>
        `INSERT INTO governance_ballots (id, tenant_id, contest_id, choice) VALUES (${id}, '${tenantId}', '${secretId}', ARRAY[gen_random_uuid()])`;
      await expect(asApp(row())).rejects.toThrow(
        /written when a secret contest closes/,
      );
      const close = `UPDATE governance_contests SET closed_at = now(), turnout = 0 WHERE id = '${secretId}'`;
      await expect(
        asApp(close, row("'0192f1c2-7a4b-7c3d-8e9f-0a1b2c3d4e5f'")),
      ).rejects.toThrow(/governance_ballots_random_id/);
      // A close that leaves the box, or writes more rows than votes, fails at commit.
      await expect(asApp(close)).rejects.toThrow(/ballots in a box/);
      await expect(
        asApp(
          close,
          row(),
          `DELETE FROM governance_ballot_boxes WHERE contest_id = '${secretId}'`,
        ),
      ).rejects.toThrow(/0 participations, 0 ballots in a box, 1 ballot rows/);
      await asApp(
        close,
        `DELETE FROM governance_ballot_boxes WHERE contest_id = '${secretId}'`,
      );
      const closed = await inTx((tx) =>
        closedContestRows(tx, { tenantId, unitId, accountId }),
      );
      await expect(
        attempt(
          migrator,
          `UPDATE governance_ballots SET choice = ARRAY[gen_random_uuid()] WHERE contest_id = '${closed}'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(
          migrator,
          `DELETE FROM governance_ballots WHERE contest_id = '${closed}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('a ballot row has an id, a contest and a choice: nothing that names or times it', async () => {
      const { rows } = await app.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'governance_ballots' ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'choice',
        'contest_id',
        'id',
        'tenant_id',
      ]);
      const box = await app.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'governance_ballot_boxes' ORDER BY column_name`,
      );
      expect(box.rows.map((r) => r.column_name)).toEqual([
        'ballots',
        'contest_id',
        'secret',
        'tenant_id',
      ]);
    });
  });
});

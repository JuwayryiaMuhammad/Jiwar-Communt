import { Client } from 'pg';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { controlRow, minorRow, unitRow } from '../setup/children-rows';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { dutyFileRow } from '../setup/security-rows';
import { required } from '../setup/test-env';

/**
 * The children's tables (ADR 0054) at the database: what the app may
 * write, what the triggers keep, and the shapes the CHECKs hold whatever
 * the services do. A live control on an adult is impossible: the member's
 * coming of age cascades into the control and the CHECK refuses it.
 */
describe('Children tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let managerId: string;
  let otherId: string;
  let unitId: string;
  let memberId: string;
  let controlId: string;
  let endedMemberId: string;
  let endedId: string;
  let photoId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Children schema');
    managerId = (await createAccountRow(h, tenantId)).id;
    otherId = (await createAccountRow(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        unitId = await unitRow(tx, tenantId);
        memberId = await minorRow(tx, {
          tenantId,
          unitId,
          addedById: managerId,
        });
        controlId = await controlRow(tx, {
          tenantId,
          unitId,
          memberId,
          turnedOnById: managerId,
        });
        endedMemberId = await minorRow(tx, {
          tenantId,
          unitId,
          addedById: managerId,
        });
        endedId = await controlRow(tx, {
          tenantId,
          unitId,
          memberId: endedMemberId,
          turnedOnById: managerId,
        });
        await tx.childControl.update({
          where: { id: endedId },
          data: {
            endedAt: new Date(),
            endReason: 'household',
            endedById: managerId,
            cardTokenHash: null,
            cardIssuedAt: null,
          },
        });
        photoId = await dutyFileRow(tx, tenantId, 'child_photo');
      }),
    );
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

  async function attempt(client: Client, ...statements: string[]) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await client.query(sql);
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
  const live = () => `id = '${controlId}'`;
  const ended = () => `id = '${endedId}'`;

  it('the app updates controls but never deletes or truncates them', async () => {
    expect(await privileges('child_controls')).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
      truncate: false,
    });
  });

  it('a live control keeps its card: dropping it without ending is refused', async () => {
    await expect(
      asApp(
        `UPDATE child_controls SET card_token_hash = NULL, card_issued_at = NULL WHERE ${live()}`,
      ),
    ).rejects.toThrow(/never changes|child_controls_card_while_live/);
  });

  it('a control is never deleted or truncated, even by the owner', async () => {
    await expect(
      attempt(migrator, `DELETE FROM child_controls WHERE ${live()}`),
    ).rejects.toThrow(/never deleted/);
    await expect(
      attempt(migrator, 'TRUNCATE child_controls CASCADE'),
    ).rejects.toThrow(/append-only|immutable|never/);
  });

  it('whose control it is never changes', async () => {
    for (const set of [
      `member_id = '${endedMemberId}'`,
      `turned_on_by_account_id = '${otherId}'`,
      "turned_on_at = turned_on_at - interval '1 day'",
    ])
      await expect(
        asApp(`UPDATE child_controls SET ${set} WHERE ${live()}`),
      ).rejects.toThrow(/never changes/);
  });

  it('a new card comes with a later issue time; the switches and the photo change while live', async () => {
    await asApp(
      `UPDATE child_controls SET card_token_hash = repeat('a', 64), card_issued_at = card_issued_at + interval '1 millisecond', may_leave_alone = true, photo_file_id = '${photoId}' WHERE ${live()}`,
    );
    await expect(
      asApp(
        `UPDATE child_controls SET card_token_hash = repeat('b', 64) WHERE ${live()}`,
      ),
    ).rejects.toThrow(/never changes/);
  });

  it('it ends once, and then nothing changes', async () => {
    for (const set of [
      'ended_at = NULL, end_reason = NULL, ended_by_account_id = NULL',
      "end_reason = 'left_household', ended_by_account_id = NULL",
      'may_leave_alone = true',
      "ended_at = ended_at + interval '1 minute'",
    ])
      await expect(
        asApp(`UPDATE child_controls SET ${set} WHERE ${ended()}`),
      ).rejects.toThrow(/ends once/);
  });

  it('the shapes hold: a card and no photo after the end, a reason, who ended it', async () => {
    for (const [set, check] of [
      [
        "card_token_hash = repeat('Z', 64), card_issued_at = card_issued_at + interval '1 millisecond'",
        'card_hash_shape',
      ],
      [
        `ended_at = now(), end_reason = 'household', ended_by_account_id = '${managerId}', card_token_hash = NULL, card_issued_at = NULL, photo_file_id = '${photoId}'`,
        'photo_while_live',
      ],
      [
        `ended_at = now(), end_reason = 'came_of_age', ended_by_account_id = '${managerId}', card_token_hash = NULL, card_issued_at = NULL`,
        'ended_shape',
      ],
      [
        `ended_at = now(), end_reason = 'household', card_token_hash = NULL, card_issued_at = NULL`,
        'ended_shape',
      ],
      [`ended_by_account_id = '${managerId}'`, 'ended_shape'],
      [
        `ended_at = now(), end_reason = 'bored', card_token_hash = NULL, card_issued_at = NULL`,
        'end_reason',
      ],
    ])
      await expect(
        asApp(`UPDATE child_controls SET ${set} WHERE ${live()}`),
      ).rejects.toThrow(new RegExp(`child_controls_${check}`));
  });

  it("a member's coming of age cascades: refused while the control is live, followed once it ended", async () => {
    const comeOfAge = (id: string) =>
      `UPDATE household_members
          SET is_minor = false, account_id = '${otherId}', full_name = NULL,
              id_document_number = NULL, id_document_type = NULL, nationality = NULL
        WHERE id = '${id}'`;
    await expect(asApp(comeOfAge(memberId))).rejects.toThrow(
      /child_controls_live_on_minor/,
    );
    const res = await asApp(
      comeOfAge(endedMemberId),
      `SELECT member_is_minor FROM child_controls WHERE ${ended()}`,
    );
    expect(res?.rows).toEqual([{ member_is_minor: false }]);
  });

  it("a control names one of the unit's minors: never an adult, never another unit", async () => {
    const other = await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx((tx) => unitRow(tx, tenantId)),
    );
    await expect(
      asApp(
        `INSERT INTO child_controls (id, tenant_id, unit_id, member_id, may_leave_alone, notify_pickups, card_token_hash, card_issued_at, turned_on_by_account_id, turned_on_at, updated_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${other}', '${endedMemberId}', false, true, repeat('c', 64), now(), '${managerId}', now(), now())`,
      ),
    ).rejects.toThrow(/child_controls_member_fkey/);
    await expect(
      asApp(
        `INSERT INTO child_controls (id, tenant_id, unit_id, member_id, member_is_minor, may_leave_alone, notify_pickups, card_token_hash, card_issued_at, turned_on_by_account_id, turned_on_at, updated_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${unitId}', '${endedMemberId}', false, false, true, repeat('c', 64), now(), '${managerId}', now(), now())`,
      ),
    ).rejects.toThrow(
      /child_controls_member_fkey|child_controls_live_on_minor/,
    );
  });

  it('one live control per child', async () => {
    await expect(
      asApp(
        `INSERT INTO child_controls (id, tenant_id, unit_id, member_id, may_leave_alone, notify_pickups, card_token_hash, card_issued_at, turned_on_by_account_id, turned_on_at, updated_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${unitId}', '${memberId}', false, true, repeat('d', 64), now(), '${managerId}', now(), now())`,
      ),
    ).rejects.toThrow(/child_controls_one_live_per_member/);
  });
});

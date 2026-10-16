import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  HASH,
  permitFileRow,
  permitGuestRow,
  permitRow,
  permitWorkerRow,
} from '../setup/permits-rows';
import { required } from '../setup/test-env';

/**
 * The permits tables (ADR 0049) at the database: what the app may write,
 * what the triggers keep, and the shapes the CHECKs hold whatever the
 * services do.
 */
describe('Permits tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let unitId: string;
  let otherUnitId: string;
  let worksId: string;
  let moveId: string;
  let exitId: string;
  let eventId: string;
  let workerId: string;
  let guestId: string;
  let photoId: string;
  let gateId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Permits schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    otherUnitId = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        const base = { tenantId, unitId, requestedById: accountId };
        gateId = (
          await tx.gate.create({
            data: {
              id: newId(),
              tenantId,
              name: 'Schema gate',
              kind: 'mixed',
            },
          })
        ).id;
        worksId = await permitRow(tx, base);
        moveId = await permitRow(tx, { ...base, kind: 'move' });
        photoId = await permitFileRow(tx, tenantId, 'permit_photo');
        exitId = await permitRow(tx, {
          ...base,
          kind: 'material_exit',
          data: { photoFileId: photoId },
        });
        eventId = await permitRow(tx, { ...base, kind: 'event' });
        workerId = await permitWorkerRow(tx, {
          tenantId,
          permitId: worksId,
          addedById: accountId,
          photoFileId: await permitFileRow(tx, tenantId),
        });
        guestId = await permitGuestRow(tx, {
          tenantId,
          permitId: eventId,
          addedById: accountId,
        });
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
  const set = (id: string, assignments: string) =>
    `UPDATE unit_permits SET ${assignments} WHERE id = '${id}'`;
  const approve = (id: string) =>
    set(
      id,
      `status = 'approved', decision_source = 'manager', decided_by_account_id = '${accountId}', decided_at = now()`,
    );

  it('nothing of the domain is deleted or truncated by the app', async () => {
    for (const table of [
      'permit_settings',
      'permit_counters',
      'unit_permits',
      'permit_workers',
      'permit_guests',
    ])
      expect({ table, ...(await privileges(table)) }).toEqual({
        table,
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
  });

  it('the truck’s and the guests’ plates are keyed like every other plate (ADR 0045, 0047)', async () => {
    const keys = await attempt(
      migrator,
      `SELECT p.plate_key AS move, g.plate_key AS guest
         FROM unit_permits p, permit_guests g
        WHERE p.id = '${moveId}' AND g.id = '${guestId}'`,
    );
    expect(keys!.rows[0]).toEqual({ move: 'ROW123', guest: 'GST1' });
    // A guest keeps their plate until the purge.
    await expect(
      asApp(
        `UPDATE permit_guests SET vehicle_plate = 'أ ب ١٢٣' WHERE id = '${guestId}'`,
      ),
    ).rejects.toThrow(/keeps who they are/);
    const inserted = await attempt(
      migrator,
      `INSERT INTO unit_permits (id, tenant_id, number, kind, unit_id, requested_by_account_id, starts_at, ends_at, truck_plate, items_description, updated_at)
       VALUES (gen_random_uuid(), '${tenantId}', 777001, 'move', '${unitId}', '${accountId}', now(), now() + interval '1 hour', 'أ ب ١٢٣', 'Sofa', now())
       RETURNING plate_key`,
    );
    expect(inserted!.rows[0]).toEqual({ plate_key: 'اب123' });
  });

  describe('permits', () => {
    it('keeps what it asks', async () => {
      for (const assignments of [
        'number = number + 1',
        `kind = 'move'`,
        `unit_id = '${otherUnitId}'`,
        `requested_by_account_id = gen_random_uuid()`,
        "starts_at = starts_at + interval '1 hour'",
        "ends_at = ends_at + interval '1 day'",
        'daily_to = 1000',
        `work_type = 'finishing'`,
        `description = 'Other words'`,
        "created_at = now() - interval '1 day'",
      ])
        await expect(asApp(set(worksId, assignments))).rejects.toThrow(
          /keeps what it asks/,
        );
      await expect(asApp(set(eventId, 'guest_limit = 30'))).rejects.toThrow(
        /keeps what it asks/,
      );
    });

    it('moves forward only; decided, revoked and cancelled once', async () => {
      await expect(
        asApp(approve(worksId), set(worksId, `status = 'pending'`)),
      ).rejects.toThrow(/moves forward only/);
      await expect(
        asApp(
          approve(worksId),
          set(worksId, `decided_at = now() + interval '1 minute'`),
        ),
      ).rejects.toThrow(/moves forward only/);
      await expect(
        asApp(
          approve(worksId),
          set(
            worksId,
            `status = 'revoked', revoked_at = now(), revoked_by_account_id = '${accountId}', revoke_reason = 'complaint'`,
          ),
          set(worksId, `revoke_reason = 'other'`),
        ),
      ).rejects.toThrow(/moves forward only/);
      await expect(
        asApp(
          set(
            worksId,
            `status = 'cancelled', cancelled_at = now(), cancel_side = 'system', cancel_reason = 'not_decided'`,
          ),
          set(worksId, `cancel_reason = 'requester_left'`),
        ),
      ).rejects.toThrow(/moves forward only/);
      // Rejected is over.
      await expect(
        asApp(
          set(
            worksId,
            `status = 'rejected', decision_source = 'manager', decided_by_account_id = '${accountId}', decided_at = now(), reject_reason = 'outside_rules'`,
          ),
          approve(worksId),
        ),
      ).rejects.toThrow(/moves forward only/);
      // The legal path, then the erasure's clearing and the purge still go.
      await expect(
        asApp(
          approve(worksId),
          set(
            worksId,
            `status = 'cancelled', cancelled_at = now(), cancelled_by_account_id = '${accountId}', cancel_side = 'requester', cancel_reason = 'plans_changed'`,
          ),
          set(
            worksId,
            'contractor_company = NULL, description = NULL, text_cleared_at = now()',
          ),
          set(worksId, 'purged_at = now()'),
        ),
      ).resolves.toBeDefined();
    });

    it('a material exit is used once; only a material exit is used', async () => {
      const use = (id: string) =>
        set(
          id,
          `status = 'used', used_at = now(), used_by_account_id = '${accountId}', used_gate_id = '${gateId}'`,
        );
      await expect(
        asApp(
          approve(exitId),
          use(exitId),
          set(exitId, "used_at = now() + interval '1 minute'"),
        ),
      ).rejects.toThrow(/moves forward only/);
      await expect(asApp(approve(worksId), use(worksId))).rejects.toThrow(
        /unit_permits_kind_shape/,
      );
      // Never used before its approval.
      await expect(asApp(use(exitId))).rejects.toThrow(/moves forward only/);
      await expect(asApp(approve(exitId), use(exitId))).resolves.toBeDefined();
    });

    it('the words go once, all together; the plate and the photo once, with the purge', async () => {
      await expect(
        asApp(
          set(
            worksId,
            'description = NULL, contractor_company = NULL, text_cleared_at = now()',
          ),
          set(worksId, `text_cleared_at = now() + interval '1 minute'`),
        ),
      ).rejects.toThrow(/keeps what it asks/);
      await expect(
        asApp(set(worksId, 'text_cleared_at = now()')),
      ).rejects.toThrow(/unit_permits_text_cleared/);
      await expect(asApp(set(moveId, 'truck_plate = NULL'))).rejects.toThrow(
        /keeps what it asks/,
      );
      await expect(
        asApp(set(moveId, 'truck_plate = NULL, purged_at = now()')),
      ).resolves.toBeDefined();
      await expect(asApp(set(exitId, 'photo_file_id = NULL'))).rejects.toThrow(
        /keeps what it asks/,
      );
      await expect(
        asApp(set(exitId, 'photo_file_id = NULL, purged_at = now()')),
      ).resolves.toBeDefined();
      await expect(asApp(set(exitId, 'purged_at = now()'))).rejects.toThrow(
        /unit_permits_purged/,
      );
    });

    it('is never deleted, even by its owner', async () => {
      await expect(
        attempt(migrator, `DELETE FROM unit_permits WHERE id = '${worksId}'`),
      ).rejects.toThrow(/never deleted/);
    });

    const insert = (cols: Record<string, string>) => {
      const all = {
        id: 'gen_random_uuid()',
        tenant_id: `'${tenantId}'`,
        number: String(700_000 + Math.floor(Math.random() * 99_999)),
        unit_id: `'${unitId}'`,
        requested_by_account_id: `'${accountId}'`,
        starts_at: 'now()',
        ends_at: "now() + interval '1 day'",
        updated_at: 'now()',
        ...cols,
      };
      return `INSERT INTO unit_permits (${Object.keys(all).join(', ')}) VALUES (${Object.values(all).join(', ')})`;
    };
    const works = {
      kind: `'works'`,
      work_type: `'renovation'`,
      daily_from: '540',
      daily_to: '1020',
      contractor_company: `'Co'`,
      description: `'Words'`,
    };

    it.each([
      [
        'works without their hours',
        () => insert({ ...works, daily_to: 'NULL' }),
        /unit_permits_kind_shape/,
      ],
      [
        'works without the resident’s words',
        () => insert({ ...works, description: 'NULL' }),
        /unit_permits_kind_shape/,
      ],
      [
        'a move with a works description',
        () =>
          insert({
            kind: `'move'`,
            truck_plate: `'A 1'`,
            items_description: `'Sofa'`,
            description: `'Words'`,
          }),
        /unit_permits_kind_shape/,
      ],
      [
        'a move without its truck',
        () => insert({ kind: `'move'`, items_description: `'Sofa'` }),
        /unit_permits_kind_shape/,
      ],
      [
        'an event without its size',
        () => insert({ kind: `'event'` }),
        /unit_permits_kind_shape/,
      ],
      [
        'an event of 151',
        () => insert({ kind: `'event'`, guest_limit: '151' }),
        /unit_permits_guest_limit/,
      ],
      [
        'a material exit of no items',
        () => insert({ kind: `'material_exit'`, items: `'[]'` }),
        /unit_permits_items_shape/,
      ],
      [
        'a material exit of 31 items',
        () =>
          insert({
            kind: `'material_exit'`,
            items: `'${JSON.stringify(Array.from({ length: 31 }, () => ({ name: 'x', quantity: 1 })))}'`,
          }),
        /unit_permits_items_shape/,
      ],
      [
        'hours that end before they start',
        () => insert({ ...works, daily_from: '600', daily_to: '600' }),
        /unit_permits_daily_hours/,
      ],
      [
        'a window that ends before it starts',
        () => insert({ ...works, ends_at: "now() - interval '1 day'" }),
        /unit_permits_window/,
      ],
      [
        'an unknown kind of work',
        () => insert({ ...works, work_type: `'demolition'` }),
        /unit_permits_work_type/,
      ],
      [
        'approved at once, works',
        () =>
          insert({
            ...works,
            status: `'approved'`,
            decision_source: `'auto'`,
            decided_at: 'now()',
          }),
        /unit_permits_decision/,
      ],
      [
        'approved without a decision',
        () => insert({ ...works, status: `'approved'` }),
        /unit_permits_state_shape/,
      ],
      [
        'rejected with an unknown reason',
        () =>
          insert({
            ...works,
            status: `'rejected'`,
            decision_source: `'manager'`,
            decided_by_account_id: `'${accountId}'`,
            decided_at: 'now()',
            reject_reason: `'mood'`,
          }),
        /unit_permits_reject_reason/,
      ],
      [
        'cancelled by the system for a requester’s reason',
        () =>
          insert({
            ...works,
            status: `'cancelled'`,
            cancelled_at: 'now()',
            cancel_side: `'system'`,
            cancel_reason: `'plans_changed'`,
          }),
        /unit_permits_cancel/,
      ],
      [
        'cancelled by a requester for the system’s reason',
        () =>
          insert({
            ...works,
            status: `'cancelled'`,
            cancelled_at: 'now()',
            cancelled_by_account_id: `'${accountId}'`,
            cancel_side: `'requester'`,
            cancel_reason: `'not_decided'`,
          }),
        /unit_permits_cancel/,
      ],
    ])('refuses %s', async (_name, sql, error) => {
      await expect(asApp(sql())).rejects.toThrow(error);
    });

    it('the minimal shapes of each kind are accepted', async () => {
      await expect(
        asApp(
          insert(works),
          insert({
            kind: `'move'`,
            truck_plate: `'A 1'`,
            items_description: `'Sofa'`,
          }),
          insert({
            kind: `'material_exit'`,
            items: `'[{"name":"Tiles","quantity":3}]'`,
          }),
          insert({
            kind: `'event'`,
            guest_limit: '20',
            status: `'approved'`,
            decision_source: `'auto'`,
            decided_at: 'now()',
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('workers', () => {
    const set = (assignments: string) =>
      `UPDATE permit_workers SET ${assignments} WHERE id = '${workerId}'`;

    it('keep who they are until the purge takes all of it at once', async () => {
      for (const assignments of [
        `full_name = 'Someone Else'`,
        `id_last4_hash = '${'b'.repeat(64)}'`,
        `id_type = 'passport'`,
        `permit_id = '${eventId}'`,
      ])
        await expect(asApp(set(assignments))).rejects.toThrow(
          /keeps who they are|permit_workers_permit_fkey/,
        );
      await expect(
        asApp(set('full_name = NULL, purged_at = now()')),
      ).rejects.toThrow(/permit_workers_purged/);
      await expect(
        asApp(
          set(
            'full_name = NULL, photo_file_id = NULL, id_last4_hash = NULL, purged_at = now()',
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('are removed once; the management says why, the requester never has to', async () => {
      await expect(
        asApp(
          set(
            `removed_at = now(), removed_by_account_id = '${accountId}', removed_side = 'requester'`,
          ),
          set(`removed_at = now() + interval '1 minute'`),
        ),
      ).rejects.toThrow(/keeps who they are/);
      await expect(
        asApp(
          set(
            `removed_at = now(), removed_by_account_id = '${accountId}', removed_side = 'management'`,
          ),
        ),
      ).rejects.toThrow(/permit_workers_removal/);
      await expect(
        asApp(
          set(
            `removed_at = now(), removed_by_account_id = '${accountId}', removed_side = 'management', remove_reason = 'misconduct'`,
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('carry a hash, never four plain characters', async () => {
      await expect(
        asApp(
          `INSERT INTO permit_workers (id, tenant_id, permit_id, full_name, photo_file_id, id_type, id_last4_hash, added_by_account_id, updated_at)
           VALUES (gen_random_uuid(), '${tenantId}', '${worksId}', 'Worker', NULL, 'national_id', '1234', '${accountId}', now())`,
        ),
      ).rejects.toThrow(/permit_workers_purged|permit_workers_text/);
      expect(HASH).toMatch(/^[0-9a-f]{64}$/);
    });

    it('are never deleted, even by their owner', async () => {
      await expect(
        attempt(
          migrator,
          `DELETE FROM permit_workers WHERE id = '${workerId}'`,
        ),
      ).rejects.toThrow(/never deleted/);
    });
  });

  describe('guests', () => {
    const set = (assignments: string) =>
      `UPDATE permit_guests SET ${assignments} WHERE id = '${guestId}'`;

    it('keep who they are until the purge; removed once', async () => {
      await expect(asApp(set(`full_name = 'Someone Else'`))).rejects.toThrow(
        /keeps who they are/,
      );
      await expect(
        asApp(
          set('removed_at = now()'),
          set(`removed_at = now() + interval '1 minute'`),
        ),
      ).rejects.toThrow(/keeps who they are/);
      await expect(
        asApp(set('full_name = NULL, purged_at = now()')),
      ).rejects.toThrow(/permit_guests_purged/);
      await expect(
        asApp(set('full_name = NULL, vehicle_plate = NULL, purged_at = now()')),
      ).resolves.toBeDefined();
    });

    it('are never deleted, even by their owner', async () => {
      await expect(
        attempt(migrator, `DELETE FROM permit_guests WHERE id = '${guestId}'`),
      ).rejects.toThrow(/never deleted/);
    });
  });
});

import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { FILE_PURPOSES, FILE_TYPES } from '../../src/core/files/purposes';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { placeRow } from '../setup/safety-rows';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  dutyFileRow,
  foundItemPhotoRow,
  foundItemRow,
  gateRow,
  handoverItemRow,
  handoverRow,
  instructionRow,
  recipientRow,
  shiftRow,
  slotRow,
  swapRow,
  taskPhotoRow,
  taskRow,
  templateRow,
} from '../setup/security-rows';
import { required } from '../setup/test-env';

/**
 * The guard shifts and tasks tables (ADR 0050) at the database: what the
 * app may write, what the triggers keep, and the shapes the CHECKs hold
 * whatever the services do.
 */
describe('Guard duty tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let guardId: string;
  let otherId: string;
  let gateId: string;
  let otherGateId: string;
  let templateId: string;
  let slotId: string;
  let shiftId: string;
  let endedShiftId: string;
  let itemId: string;
  let handoverId: string;
  let taskId: string;
  let photoId: string;
  let swapId: string;
  let instructionId: string;
  let recipientId: string;
  let foundId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Guard duty schema');
    guardId = (await createAccountRow(h, tenantId)).id;
    otherId = (await createAccountRow(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        gateId = await gateRow(tx, tenantId);
        otherGateId = await gateRow(tx, tenantId);
        templateId = await templateRow(tx, {
          tenantId,
          guardId,
          gateId,
          createdById: otherId,
        });
        slotId = await slotRow(tx, {
          tenantId,
          guardId,
          gateId,
          createdById: otherId,
        });
        endedShiftId = await shiftRow(tx, { tenantId, guardId, gateId });
        itemId = await handoverItemRow(tx, tenantId);
        handoverId = await handoverRow(tx, {
          tenantId,
          shiftId: endedShiftId,
          guardId,
          gateId,
        });
        taskId = await taskRow(tx, { tenantId, gateId, createdById: otherId });
        photoId = await taskPhotoRow(tx, {
          tenantId,
          taskId,
          fileId: await dutyFileRow(tx, tenantId),
          uploadedById: guardId,
        });
        swapId = await swapRow(tx, {
          tenantId,
          requesterId: guardId,
          slotId: await slotRow(tx, {
            tenantId,
            guardId,
            gateId,
            createdById: otherId,
            inHours: 48,
          }),
          colleagueId: otherId,
        });
        instructionId = await instructionRow(tx, {
          tenantId,
          gateId,
          createdById: otherId,
        });
        recipientId = await recipientRow(tx, {
          tenantId,
          instructionId,
          accountId: guardId,
        });
        foundId = await foundItemRow(tx, {
          tenantId,
          placeId: await placeRow(tx, tenantId),
          registeredById: guardId,
        });
        await foundItemPhotoRow(tx, {
          tenantId,
          itemId: foundId,
          fileId: await dutyFileRow(tx, tenantId, 'found_item_photo'),
          uploadedById: guardId,
        });
        shiftId = newId();
        await tx.guardShift.create({
          data: {
            id: shiftId,
            tenantId,
            guardAccountId: guardId,
            gateId,
            startedAt: new Date(Date.now() - 3_600_000),
          },
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

  it('nothing of the domain is deleted or truncated by the app', async () => {
    for (const table of [
      'guard_shifts',
      'guard_roster_templates',
      'guard_roster_slots',
      'guard_handover_items',
      'guard_handovers',
      'guard_tasks',
      'guard_shift_swaps',
      'guard_instructions',
      'guard_instruction_recipients',
      'found_items',
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

  it('nothing is deleted or truncated, even by the owner', async () => {
    for (const table of [
      'guard_shifts',
      'guard_roster_templates',
      'guard_roster_slots',
      'guard_handover_items',
      'guard_handovers',
      'guard_tasks',
      'guard_task_photos',
      'guard_shift_swaps',
      'guard_instructions',
      'guard_instruction_recipients',
      'found_items',
      'found_item_photos',
    ]) {
      // A row to refuse: a row trigger never fires on a DELETE of none.
      const found = await attempt(
        migrator,
        `SELECT 1 FROM "${table}" WHERE tenant_id = '${tenantId}' LIMIT 1`,
      );
      expect([table, found?.rowCount]).toEqual([table, 1]);
      await expect(
        attempt(
          migrator,
          `DELETE FROM "${table}" WHERE tenant_id = '${tenantId}'`,
        ),
      ).rejects.toThrow(/never deleted|never removed|append-only/);
      await expect(
        attempt(migrator, `TRUNCATE "${table}" CASCADE`),
      ).rejects.toThrow(/append-only|immutable|never/);
    }
  });

  describe('guard_shifts', () => {
    const where = () => `id = '${shiftId}'`;
    const end = () =>
      `UPDATE guard_shifts SET ended_at = now(), end_reason = 'guard' WHERE ${where()}`;

    it('who, where and when never change', async () => {
      for (const set of [
        `guard_account_id = '${otherId}'`,
        `gate_id = '${otherGateId}'`,
        "started_at = started_at - interval '1 hour'",
      ])
        await expect(
          asApp(`UPDATE guard_shifts SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps who, where and when/);
    });

    it('ends once; what the end records is written once, at the end only', async () => {
      await expect(
        asApp(`UPDATE guard_shifts SET overtime_minutes = 5 WHERE ${where()}`),
      ).rejects.toThrow(/guard_shifts_minutes_at_end/);
      await expect(
        asApp(
          end(),
          `UPDATE guard_shifts SET overtime_minutes = 5, unscheduled_minutes = 5 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_shifts_minutes_at_end/);
      await expect(
        asApp(
          end(),
          `UPDATE guard_shifts SET overtime_minutes = 5 WHERE ${where()}`,
          `UPDATE guard_shifts SET overtime_minutes = 6 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who, where and when/);
      await expect(
        asApp(
          end(),
          `UPDATE guard_shifts SET ended_at = now() + interval '1 minute' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who, where and when/);
      await asApp(
        end(),
        `UPDATE guard_shifts SET unscheduled_minutes = 60 WHERE ${where()}`,
      );
    });

    it('one post, exactly', async () => {
      const id = newId();
      await expect(
        asApp(
          `INSERT INTO guard_shifts (id, tenant_id, guard_account_id) VALUES ('${id}', '${tenantId}', '${otherId}')`,
        ),
      ).rejects.toThrow(/guard_shifts_one_post/);
    });
  });

  describe('guard_roster_templates', () => {
    const where = () => `id = '${templateId}'`;

    it('keeps what it says; ended once', async () => {
      for (const set of [
        `guard_account_id = '${otherId}'`,
        `gate_id = '${otherGateId}'`,
        `schedule = '{"days":[2],"windows":[]}'`,
        'effective_from = effective_from + 1',
        "effective_until = '2031-01-01'",
      ])
        await expect(
          asApp(`UPDATE guard_roster_templates SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps what it says/);
      const ended = `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'manager', ended_by_account_id = '${otherId}' WHERE ${where()}`;
      await asApp(ended);
      await expect(
        asApp(
          ended,
          `UPDATE guard_roster_templates SET end_reason = 'guard_left', ended_by_account_id = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it says/);
    });

    it('its end names who for the management, nobody for the system', async () => {
      await expect(
        asApp(
          `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'manager' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_templates_end_by/);
      await expect(
        asApp(
          `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'guard_left', ended_by_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_templates_end_by/);
      await expect(
        asApp(
          `UPDATE guard_roster_templates SET ended_at = now(), end_reason = 'bored' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_templates_end_reason/);
    });
  });

  describe('guard_roster_slots', () => {
    const where = () => `id = '${slotId}'`;
    const cancel = (reason = 'other', by: string | null = otherId) =>
      `UPDATE guard_roster_slots SET status = 'cancelled', cancelled_at = now(), cancel_reason = '${reason}', cancelled_by_account_id = ${by ? `'${by}'` : 'NULL'} WHERE ${where()}`;
    const fill = () =>
      `UPDATE guard_roster_slots SET shift_id = '${shiftId}', late_minutes = 3 WHERE ${where()}`;

    it('keeps its post and its times', async () => {
      for (const set of [
        `gate_id = '${otherGateId}'`,
        "starts_at = starts_at + interval '1 minute'",
        "ends_at = ends_at + interval '1 minute'",
        `template_id = '${templateId}'`,
      ])
        await expect(
          asApp(`UPDATE guard_roster_slots SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps its post and times/);
    });

    it('cancelled once, and then nothing changes', async () => {
      await asApp(cancel());
      await expect(
        asApp(
          cancel(),
          `UPDATE guard_roster_slots SET absent_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
      await expect(asApp(cancel('template_ended', otherId))).rejects.toThrow(
        /guard_roster_slots_cancelled_by/,
      );
      await expect(asApp(cancel('other', null))).rejects.toThrow(
        /guard_roster_slots_cancelled_by/,
      );
      await expect(asApp(cancel('lazy'))).rejects.toThrow(
        /guard_roster_slots_cancel_reason/,
      );
    });

    it('filled once, with its lateness; a filled slot is not cancelled; absent once', async () => {
      await asApp(fill());
      await expect(
        asApp(
          fill(),
          `UPDATE guard_roster_slots SET late_minutes = 4 WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
      await expect(asApp(fill(), cancel())).rejects.toThrow(
        /guard_roster_slots_filled_shape/,
      );
      await expect(
        asApp(
          `UPDATE guard_roster_slots SET shift_id = '${shiftId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_roster_slots_filled_shape/);
      await expect(
        asApp(
          `UPDATE guard_roster_slots SET absent_at = now() WHERE ${where()}`,
          `UPDATE guard_roster_slots SET absent_at = now() + interval '1 minute' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
    });

    it('changes guard only by a swap, while unopened', async () => {
      await expect(
        asApp(
          `UPDATE guard_roster_slots SET guard_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
      await asApp(
        `UPDATE guard_roster_slots SET guard_account_id = '${otherId}', swapped_at = now() WHERE ${where()}`,
      );
      await expect(
        asApp(
          fill(),
          `UPDATE guard_roster_slots SET guard_account_id = '${otherId}', swapped_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps its post and times/);
    });

    it('a day at most, after its start, made by someone or a template', async () => {
      const insert = (starts: string, ends: string, by: string | null) =>
        asApp(
          `INSERT INTO guard_roster_slots (id, tenant_id, guard_account_id, gate_id, starts_at, ends_at, created_by_account_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${otherId}', '${gateId}', ${starts}, ${ends}, ${by ? `'${by}'` : 'NULL'}, now())`,
        );
      await expect(
        insert('now()', "now() + interval '25 hours'", otherId),
      ).rejects.toThrow(/guard_roster_slots_at_most_a_day/);
      await expect(insert('now()', 'now()', otherId)).rejects.toThrow(
        /guard_roster_slots_ends_after_start/,
      );
      await expect(
        insert('now()', "now() + interval '1 hour'", null),
      ).rejects.toThrow(/guard_roster_slots_made_by/);
    });
  });

  describe('guard_handovers', () => {
    const where = () => `id = '${handoverId}'`;
    const ack = (by: string) =>
      `UPDATE guard_handovers SET acknowledged_by_account_id = '${by}', acknowledged_shift_id = '${shiftId}', acknowledged_at = now() WHERE ${where()}`;

    it('keeps what it said', async () => {
      for (const set of [
        `guard_account_id = '${otherId}'`,
        `gate_id = '${otherGateId}'`,
        "kind = 'system'",
        `checklist = '[{"itemId":"${itemId}","label":"x"}]'`,
        "notes = 'Rewritten'",
      ])
        await expect(
          asApp(`UPDATE guard_handovers SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps what it said/);
    });

    it('acknowledged once, never by its author, and completely', async () => {
      await asApp(ack(otherId));
      await expect(
        asApp(
          ack(otherId),
          `UPDATE guard_handovers SET acknowledged_at = now() + interval '1 minute' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it said/);
      await expect(asApp(ack(guardId))).rejects.toThrow(
        /guard_handovers_not_own/,
      );
      await expect(
        asApp(
          `UPDATE guard_handovers SET acknowledged_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_handovers_ack_is_complete/);
    });

    it('its notes go once, with the moment they went', async () => {
      const clear = `UPDATE guard_handovers SET notes = NULL, notes_cleared_at = now() WHERE ${where()}`;
      await asApp(clear);
      await expect(
        asApp(
          clear,
          `UPDATE guard_handovers SET notes = 'Back' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it said/);
      await expect(
        asApp(`UPDATE guard_handovers SET notes = NULL WHERE ${where()}`),
      ).rejects.toThrow(/keeps what it said/);
    });

    it('the system’s handover carries nothing a guard would write', async () => {
      const shift = newId();
      await expect(
        asApp(
          `INSERT INTO guard_shifts (id, tenant_id, guard_account_id, gate_id, started_at, ended_at, end_reason) VALUES ('${shift}', '${tenantId}', '${otherId}', '${gateId}', now() - interval '1 hour', now(), 'gate_deactivated')`,
          `INSERT INTO guard_handovers (id, tenant_id, shift_id, guard_account_id, gate_id, kind, notes) VALUES ('${newId()}', '${tenantId}', '${shift}', '${otherId}', '${gateId}', 'system', 'Words')`,
        ),
      ).rejects.toThrow(/guard_handovers_system_shape/);
    });
  });

  describe('guard_handover_items', () => {
    it('retired, never deleted; a label of 1 to 120 characters', async () => {
      await asApp(
        `UPDATE guard_handover_items SET active = false WHERE id = '${itemId}'`,
      );
      await expect(
        asApp(
          `UPDATE guard_handover_items SET label = '' WHERE id = '${itemId}'`,
        ),
      ).rejects.toThrow(/guard_handover_items_label_length/);
    });
  });

  it('a task’s photo is only ever added: the app neither changes nor deletes one', async () => {
    expect(await privileges('guard_task_photos')).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    });
    await expect(
      attempt(
        migrator,
        `UPDATE guard_task_photos SET created_at = now() WHERE id = '${photoId}'`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  describe('guard_tasks', () => {
    const where = () => `id = '${taskId}'`;
    const take = (by = guardId) =>
      `UPDATE guard_tasks SET status = 'in_progress', taken_by_account_id = '${by}', taken_at = now() WHERE ${where()}`;
    const done = () =>
      `UPDATE guard_tasks SET status = 'done', done_at = now(), outcome = 'done', result_note = 'Fine' WHERE ${where()}`;

    it('keeps what it asks', async () => {
      for (const set of [
        "kind = 'closed_unit_inspection'",
        "title = 'Other'",
        "details = 'More'",
        'due_at = now()',
        `created_by_account_id = '${guardId}'`,
      ])
        await expect(
          asApp(`UPDATE guard_tasks SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps what it asks/);
      // Another post, without a shift's end: refused.
      await expect(
        asApp(
          `UPDATE guard_tasks SET gate_id = '${otherGateId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it asks/);
    });

    it('moves forward: taken once, done or cancelled finally; carried back to open by a shift’s end', async () => {
      await expect(
        asApp(
          take(),
          `UPDATE guard_tasks SET taken_by_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it asks/);
      await expect(
        asApp(
          take(),
          done(),
          `UPDATE guard_tasks SET outcome = 'done', result_note = 'Again' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it asks/);
      await expect(
        asApp(
          take(),
          done(),
          `UPDATE guard_tasks SET status = 'open', taken_by_account_id = NULL, taken_at = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps what it asks/);
      // Carried: to another post, open, nobody holding it.
      await asApp(
        take(),
        `UPDATE guard_tasks SET status = 'open', taken_by_account_id = NULL, taken_at = NULL, gate_id = '${otherGateId}', carried_from_shift_id = '${endedShiftId}' WHERE ${where()}`,
      );
      // An erasure takes the guard's note, once.
      await asApp(
        take(),
        done(),
        `UPDATE guard_tasks SET result_note = NULL, result_cleared_at = now() WHERE ${where()}`,
      );
    });

    it('the shapes hold: one assignee, the outcome of its kind, nobody holding an open one', async () => {
      await expect(
        asApp(`UPDATE guard_tasks SET status = 'in_progress' WHERE ${where()}`),
      ).rejects.toThrow(/guard_tasks_taken_shape/);
      await expect(
        asApp(
          take(),
          `UPDATE guard_tasks SET status = 'done', done_at = now(), outcome = 'all_clear' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_tasks_outcome/);
      await expect(
        asApp(
          `INSERT INTO guard_tasks (id, tenant_id, kind, title, gate_id, assignee_account_id, created_by_account_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', 'custom', 'Two', '${gateId}', '${guardId}', '${otherId}', now())`,
        ),
      ).rejects.toThrow(/guard_tasks_one_assignee/);
      await expect(
        asApp(
          `INSERT INTO guard_tasks (id, tenant_id, kind, gate_id, created_by_account_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', 'closed_unit_inspection', '${gateId}', '${otherId}', now())`,
        ),
      ).rejects.toThrow(/guard_tasks_kind_shape/);
    });
  });

  it('the file CHECKs recreated last accept every purpose, G3’s, G4’s, G5’s and G6b’s included: each type it takes at its limit, nothing over it, no other type', async () => {
    const file = (purpose: string, type: string, size: number) =>
      asApp(
        `INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes, status, upload_expires_at)
         VALUES (gen_random_uuid(), '${tenantId}', '${guardId}', '${purpose}', '${type}', ${size}, 'pending', now())`,
      );
    // Every purpose of the database is one of the code's, and back.
    const { rows } = await app.query<{ purpose: string }>(
      `SELECT unnest(enum_range(NULL::file_purpose))::text AS purpose`,
    );
    const purposes = rows.map((r) => r.purpose).sort();
    expect(purposes).toEqual(Object.keys(FILE_PURPOSES).sort());
    for (const purpose of [
      'contractor_photo',
      'permit_photo',
      'guard_task_photo',
      'found_item_photo',
      // G5 (ADR 0052) recreated both CHECKs after G4.
      'patrol_photo',
      // G6b (ADR 0053) recreated both after G5.
      'incident_photo',
      'blocklist_photo',
      'violation_photo',
      'violation_appeal_photo',
    ])
      expect(purposes).toContain(purpose);
    for (const purpose of purposes) {
      const { types, maxBytes } =
        FILE_PURPOSES[purpose as keyof typeof FILE_PURPOSES];
      for (const type of types) await file(purpose, type, maxBytes);
      await expect(file(purpose, types[0], maxBytes + 1)).rejects.toThrow(
        /files_size_for_purpose/,
      );
      for (const type of FILE_TYPES.filter(
        (t) => !(types as readonly string[]).includes(t),
      ))
        await expect(file(purpose, type, 100)).rejects.toThrow(
          /files_content_type_for_purpose/,
        );
    }
  });

  describe('guard_shift_swaps', () => {
    const where = () => `id = '${swapId}'`;
    const accept = `UPDATE guard_shift_swaps SET status = 'accepted', accepted_at = now() WHERE `;

    it('keeps who asked whom for what', async () => {
      for (const set of [
        `requester_account_id = '${otherId}'`,
        `colleague_account_id = '${guardId}'`,
        `colleague_slot_id = '${slotId}'`,
        "reason = 'Other words'",
      ])
        await expect(
          asApp(`UPDATE guard_shift_swaps SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/keeps who asked whom/);
    });

    it('moves forward only; decided once, with who; a decision needs an acceptance', async () => {
      await expect(
        asApp(
          `UPDATE guard_shift_swaps SET status = 'approved', decided_at = now(), decided_by_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who asked whom/);
      await expect(
        asApp(
          accept + where(),
          `UPDATE guard_shift_swaps SET status = 'approved', decided_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_shift_swaps_decided_shape/);
      await expect(
        asApp(
          accept + where(),
          `UPDATE guard_shift_swaps SET status = 'rejected', decided_at = now(), decided_by_account_id = '${otherId}', reject_reason = 'staffing' WHERE ${where()}`,
          `UPDATE guard_shift_swaps SET status = 'accepted' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who asked whom/);
      await expect(
        asApp(
          `UPDATE guard_shift_swaps SET status = 'cancelled', closed_at = now() WHERE ${where()}`,
        ),
      ).rejects.toThrow(/guard_shift_swaps_closed_shape/);
      await asApp(
        `UPDATE guard_shift_swaps SET status = 'cancelled', closed_at = now(), close_reason = 'guard_left' WHERE ${where()}`,
      );
    });

    it('its reason goes once', async () => {
      const clear = `UPDATE guard_shift_swaps SET reason = NULL, reason_cleared_at = now() WHERE ${where()}`;
      await asApp(clear);
      await expect(
        asApp(
          clear,
          `UPDATE guard_shift_swaps SET reason = 'Back' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/keeps who asked whom/);
    });

    it('a slot is in one live swap at most, on each side', async () => {
      const again = `INSERT INTO guard_shift_swaps (id, tenant_id, requester_account_id, requester_slot_id, colleague_account_id, updated_at)
        SELECT '${newId()}', tenant_id, requester_account_id, requester_slot_id, colleague_account_id, now()
          FROM guard_shift_swaps WHERE ${where()}`;
      await expect(asApp(again)).rejects.toThrow(
        /guard_shift_swaps_live_requester_slot_key/,
      );
    });
  });

  describe('guard_instructions', () => {
    it('keeps what it says, to whom; archived once, completely', async () => {
      const where = `id = '${instructionId}'`;
      for (const set of [
        "title = 'Other'",
        "body = 'Other words'",
        'urgent = true',
        `gate_id = '${otherGateId}'`,
      ])
        await expect(
          asApp(`UPDATE guard_instructions SET ${set} WHERE ${where}`),
        ).rejects.toThrow(/keeps what it says/);
      const archive = `UPDATE guard_instructions SET archived_at = now(), archived_by_account_id = '${otherId}' WHERE ${where}`;
      await asApp(archive);
      await expect(
        asApp(
          archive,
          `UPDATE guard_instructions SET archived_at = now() + interval '1 minute' WHERE ${where}`,
        ),
      ).rejects.toThrow(/keeps what it says/);
      await expect(
        asApp(
          `UPDATE guard_instructions SET archived_at = now() WHERE ${where}`,
        ),
      ).rejects.toThrow(/guard_instructions_archive_is_complete/);
      await expect(
        asApp(`UPDATE guard_instructions SET audience = 'all' WHERE ${where}`),
      ).rejects.toThrow(/keeps what it says/);
    });

    it('a recipient is acknowledged once and never moved', async () => {
      const where = `id = '${recipientId}'`;
      const ack = `UPDATE guard_instruction_recipients SET acknowledged_at = now() WHERE ${where}`;
      await asApp(ack);
      await expect(
        asApp(
          ack,
          `UPDATE guard_instruction_recipients SET acknowledged_at = now() + interval '1 minute' WHERE ${where}`,
        ),
      ).rejects.toThrow(/acknowledged once/);
      await expect(
        asApp(
          `UPDATE guard_instruction_recipients SET account_id = '${otherId}' WHERE ${where}`,
        ),
      ).rejects.toThrow(/acknowledged once/);
    });
  });

  describe('found_items', () => {
    const where = () => `id = '${foundId}'`;
    const claim = (set: string) =>
      `UPDATE found_items SET status = 'claimed', claimed_at = now(), claim_recorded_by_account_id = '${otherId}', ${set} WHERE ${where()}`;

    it('what was found never changes; it moves forward only', async () => {
      for (const set of [
        "description = 'Other'",
        "found_at = found_at - interval '1 day'",
        `registered_by_account_id = '${otherId}'`,
      ])
        await expect(
          asApp(`UPDATE found_items SET ${set} WHERE ${where()}`),
        ).rejects.toThrow(/what was found never changes/);
      await expect(
        asApp(
          claim(
            "claimant_name = 'Ann', claimant_name_expires_at = now() + interval '30 days'",
          ),
          `UPDATE found_items SET status = 'with_management', received_at = now(), received_by_account_id = '${otherId}' WHERE ${where()}`,
        ),
      ).rejects.toThrow(/what was found never changes/);
    });

    it('a claim has a claimant, and its name goes once', async () => {
      await expect(asApp(claim('claim_note = NULL'))).rejects.toThrow(
        /found_items_claimed_shape/,
      );
      const named = claim(
        "claimant_name = 'Ann', claimant_name_expires_at = now() + interval '30 days'",
      );
      const clear = `UPDATE found_items SET claimant_name = NULL, claimant_name_cleared_at = now() WHERE ${where()}`;
      await asApp(named, clear);
      await expect(
        asApp(
          named,
          clear,
          `UPDATE found_items SET claimant_name = 'Back', claimant_name_cleared_at = NULL WHERE ${where()}`,
        ),
      ).rejects.toThrow(/what was found never changes/);
      await expect(asApp(claim("claimant_name = 'Ann'"))).rejects.toThrow(
        /found_items_claimed_shape/,
      );
    });
  });
});

import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createTenant, createUnit } from '../setup/fixtures';

/**
 * ADR 0035: what the parcels tables refuse by themselves, whatever the
 * service says. Run as jiwar_app inside a tenant, like the app.
 */
describe('Parcels tables — CHECKs and indexes', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let unitId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Parcels schema');
    unitId = (await createUnit(h, tenantId)).id;
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
    await h.close();
  });

  /** Runs the statements in one transaction that is always rolled back. */
  async function attempt(
    ...statements: { sql: string; params?: unknown[] }[]
  ): Promise<void> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      for (const s of statements) await app.query(s.sql, s.params ?? []);
    } finally {
      await app.query('ROLLBACK');
    }
  }

  let number = 1;
  /** A held parcel; `set` overrides columns (`col = value` pairs, SQL text). */
  const insertParcel = (id: string, columns: Record<string, string> = {}) => {
    const base: Record<string, string> = {
      id: `'${id}'`,
      tenant_id: `'${tenantId}'`,
      number: String(number++ + 5000),
      unit_id: `'${unitId}'`,
      gate_id: `'${newId()}'`,
      shift_id: `'${newId()}'`,
      received_by_account_id: `'${newId()}'`,
      carrier: `'dhl'`,
      pieces: '1',
      updated_at: 'now()',
      ...columns,
    };
    return {
      sql: `INSERT INTO parcels (${Object.keys(base).join(', ')})
            VALUES (${Object.values(base).join(', ')})`,
    };
  };

  const closed = (status: string, extra: Record<string, string>) => ({
    status: `'${status}'`,
    closed_at: 'now()',
    ...extra,
  });

  describe('parcels', () => {
    it('a held parcel with the least it needs is accepted', async () => {
      await expect(attempt(insertParcel(newId()))).resolves.toBeUndefined();
    });

    it('pieces are 1 to 20, a label is 1 to 80 characters', async () => {
      await expect(
        attempt(insertParcel(newId(), { pieces: '0' })),
      ).rejects.toThrow(/parcels_pieces/);
      await expect(
        attempt(insertParcel(newId(), { pieces: '21' })),
      ).rejects.toThrow(/parcels_pieces/);
      await expect(
        attempt(insertParcel(newId(), { label_name: `'${'x'.repeat(81)}'` })),
      ).rejects.toThrow(/parcels_label_name_length/);
      await expect(
        attempt(insertParcel(newId(), { label_name: `''` })),
      ).rejects.toThrow(/parcels_label_name_length/);
    });

    it('the carrier is a closed list', async () => {
      await expect(
        attempt(insertParcel(newId(), { carrier: `'pigeon'` })),
      ).rejects.toThrow(/parcel_carrier/);
    });

    it('each status has exactly its own columns', async () => {
      // handed over: a time, a method and the close.
      await expect(
        attempt(insertParcel(newId(), { status: `'handed_over'` })),
      ).rejects.toThrow(/parcels_status_shape/);
      await expect(
        attempt(
          insertParcel(
            newId(),
            closed('handed_over', {
              handed_over_at: 'now()',
              handed_over_method: `'code'`,
            }),
          ),
        ),
      ).resolves.toBeUndefined();
      // a held parcel with a hand-over time.
      await expect(
        attempt(insertParcel(newId(), { handed_over_at: 'now()' })),
      ).rejects.toThrow(/parcels_status_shape/);
      // rejected: a reason from the closed list, no close.
      await expect(
        attempt(
          insertParcel(newId(), {
            status: `'rejected'`,
            rejected_at: 'now()',
            reject_reason: `'not_ours'`,
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        attempt(
          insertParcel(newId(), {
            status: `'rejected'`,
            rejected_at: 'now()',
            reject_reason: `'because'`,
          }),
        ),
      ).rejects.toThrow(/parcels_reject_reason/);
      await expect(
        attempt(
          insertParcel(newId(), { status: `'rejected'`, rejected_at: 'now()' }),
        ),
      ).rejects.toThrow(/parcels_status_shape/);
    });

    it('a returned parcel says why, and the reason agrees with its history', async () => {
      const returned = (extra: Record<string, string>) =>
        insertParcel(
          newId(),
          closed('returned', { returned_at: 'now()', ...extra }),
        );
      // unclaimed: never rejected. After a rejection: "rejected".
      await expect(
        attempt(returned({ return_reason: `'unclaimed'` })),
      ).resolves.toBeUndefined();
      await expect(
        attempt(
          returned({
            return_reason: `'rejected'`,
            rejected_at: 'now()',
            reject_reason: `'other'`,
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        attempt(returned({ return_reason: `'rejected'` })),
      ).rejects.toThrow(/parcels_status_shape/);
      await expect(
        attempt(
          returned({
            return_reason: `'unclaimed'`,
            rejected_at: 'now()',
            reject_reason: `'other'`,
          }),
        ),
      ).rejects.toThrow(/parcels_status_shape/);
      await expect(attempt(returned({}))).rejects.toThrow(
        /parcels_status_shape/,
      );
      await expect(
        attempt(returned({ return_reason: `'lost'` })),
      ).rejects.toThrow(/parcels_return_reason/);
    });

    it('the recipient pointer exists only for a resident-QR hand-over', async () => {
      const handed = (method: string, to: string | null) =>
        insertParcel(
          newId(),
          closed('handed_over', {
            handed_over_at: 'now()',
            handed_over_method: `'${method}'`,
            ...(to ? { handed_to_account_id: `'${to}'` } : {}),
          }),
        );
      await expect(
        attempt(handed('resident_qr', newId())),
      ).resolves.toBeUndefined();
      await expect(attempt(handed('code', newId()))).rejects.toThrow(
        /parcels_handed_to/,
      );
      // And a held parcel has none (the NULL trap: no method at all).
      await expect(
        attempt(
          insertParcel(newId(), { handed_to_account_id: `'${newId()}'` }),
        ),
      ).rejects.toThrow(/parcels_handed_to/);
    });

    it('a cleared parcel keeps nothing personal, and a hand-over photo needs a hand-over', async () => {
      await expect(
        attempt(
          insertParcel(
            newId(),
            closed('returned', {
              returned_at: 'now()',
              return_reason: `'unclaimed'`,
              data_cleared_at: 'now()',
              label_name: `'Someone'`,
            }),
          ),
        ),
      ).rejects.toThrow(/parcels_data_cleared/);
      await expect(
        attempt(
          insertParcel(
            newId(),
            closed('returned', {
              returned_at: 'now()',
              return_reason: `'unclaimed'`,
              data_cleared_at: 'now()',
            }),
          ),
        ),
      ).resolves.toBeUndefined();
      // Cleared needs closed.
      await expect(
        attempt(insertParcel(newId(), { data_cleared_at: 'now()' })),
      ).rejects.toThrow(/parcels_status_shape|parcels_data_cleared/);
    });

    it('a number is used once per compound', async () => {
      const id = newId();
      await expect(
        attempt(
          insertParcel(id, { number: '777' }),
          insertParcel(newId(), { number: '777' }),
        ),
      ).rejects.toThrow(/parcels_tenant_id_number_key/);
    });

    it('a parcel must be for a unit of its own compound', async () => {
      await expect(
        attempt(insertParcel(newId(), { unit_id: `'${newId()}'` })),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe('parcel_credentials', () => {
    const parcelId = newId();
    const credential = (columns: Record<string, string> = {}, id = newId()) => {
      const base: Record<string, string> = {
        id: `'${id}'`,
        tenant_id: `'${tenantId}'`,
        parcel_id: `'${parcelId}'`,
        kind: `'holder'`,
        code_hash: `'${'a'.repeat(64)}'`,
        qr_token_hash: `'${'b'.repeat(64)}'`,
        created_by_account_id: `'${newId()}'`,
        ...columns,
      };
      return {
        sql: `INSERT INTO parcel_credentials (${Object.keys(base).join(', ')})
              VALUES (${Object.values(base).join(', ')})`,
      };
    };
    // Built when a test runs: the compound exists only after beforeAll.
    const parcel = () => insertParcel(parcelId);

    it('a live credential has both hashes; an ended one has neither', async () => {
      await expect(attempt(parcel(), credential())).resolves.toBeUndefined();
      await expect(
        attempt(parcel(), credential({ qr_token_hash: 'NULL' })),
      ).rejects.toThrow(/parcel_credentials_hashes_while_live/);
      await expect(
        attempt(
          parcel(),
          credential({
            code_hash: 'NULL',
            qr_token_hash: 'NULL',
            ended_at: 'now()',
            end_reason: `'handed_over'`,
          }),
        ),
      ).resolves.toBeUndefined();
      // Ended but still holding a hash, or live with nothing.
      await expect(
        attempt(
          parcel(),
          credential({ ended_at: 'now()', end_reason: `'handed_over'` }),
        ),
      ).rejects.toThrow(/parcel_credentials_hashes_while_live/);
      await expect(
        attempt(
          parcel(),
          credential({ code_hash: 'NULL', qr_token_hash: 'NULL' }),
        ),
      ).rejects.toThrow(/parcel_credentials_hashes_while_live/);
    });

    it('the end reason is from a closed list and goes with the end', async () => {
      const ended = (reason: string | null) =>
        credential({
          code_hash: 'NULL',
          qr_token_hash: 'NULL',
          ended_at: 'now()',
          ...(reason ? { end_reason: `'${reason}'` } : {}),
        });
      await expect(attempt(parcel(), ended(null))).rejects.toThrow(
        /parcel_credentials_end/,
      );
      await expect(attempt(parcel(), ended('whim'))).rejects.toThrow(
        /parcel_credentials_end/,
      );
      await expect(
        attempt(parcel(), ended('authorizer_left')),
      ).resolves.toBeUndefined();
    });

    it('a delegate name is for a delegate, 1 to 80 characters, and goes when the delegate does', async () => {
      const delegate = (extra: Record<string, string>) =>
        credential({ kind: `'delegate'`, ...extra });
      await expect(
        attempt(parcel(), delegate({ delegate_name: `'Ali'` })),
      ).resolves.toBeUndefined();
      await expect(
        attempt(parcel(), credential({ delegate_name: `'Ali'` })),
      ).rejects.toThrow(/parcel_credentials_delegate_name/);
      await expect(
        attempt(parcel(), delegate({ delegate_name: `'${'x'.repeat(81)}'` })),
      ).rejects.toThrow(/parcel_credentials_delegate_name/);
      // Revoked, or its authorizer left: no name is kept.
      for (const reason of ['revoked', 'authorizer_left'])
        await expect(
          attempt(
            parcel(),
            delegate({
              delegate_name: `'Ali'`,
              code_hash: 'NULL',
              qr_token_hash: 'NULL',
              ended_at: 'now()',
              end_reason: `'${reason}'`,
            }),
          ),
        ).rejects.toThrow(/parcel_credentials_revoked_keeps_no_name/);
      // Handed over to them: the name stays for the 30 days.
      await expect(
        attempt(
          parcel(),
          delegate({
            delegate_name: `'Ali'`,
            code_hash: 'NULL',
            qr_token_hash: 'NULL',
            ended_at: 'now()',
            end_reason: `'handed_over'`,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it('one holder per parcel(), one live delegate, and a live code or QR is unique in the compound', async () => {
      await expect(
        attempt(
          parcel(),
          credential(),
          credential({
            code_hash: `'${'c'.repeat(64)}'`,
            qr_token_hash: `'${'d'.repeat(64)}'`,
          }),
        ),
      ).rejects.toThrow(/parcel_credentials_one_holder/);
      const d = (code: string, qr: string, name = 'Ali') =>
        credential({
          kind: `'delegate'`,
          delegate_name: `'${name}'`,
          code_hash: `'${code.repeat(64)}'`,
          qr_token_hash: `'${qr.repeat(64)}'`,
        });
      await expect(
        attempt(parcel(), credential(), d('e', 'f'), d('g', 'h')),
      ).rejects.toThrow(/parcel_credentials_one_live_delegate/);
      // Another parcel's live credential with the same code, same compound.
      const otherId = newId();
      await expect(
        attempt(
          parcel(),
          insertParcel(otherId),
          credential(),
          credential({ parcel_id: `'${otherId}'` }),
        ),
      ).rejects.toThrow(/parcel_credentials_live_code/);
    });
  });

  describe('parcel_settings', () => {
    const set = (reminder: number, manager: number) =>
      attempt({
        sql: `UPDATE parcel_settings SET parcel_reminder_days = $1, parcel_manager_days = $2`,
        params: [reminder, manager],
      });

    it('the defaults are 3 and 14, and the ranges hold', async () => {
      await expect(set(3, 14)).resolves.toBeUndefined();
      await expect(set(0, 14)).rejects.toThrow(/parcel_settings_ranges/);
      await expect(set(31, 90)).rejects.toThrow(/parcel_settings_ranges/);
      await expect(set(1, 91)).rejects.toThrow(/parcel_settings_ranges/);
      await expect(set(5, 5)).rejects.toThrow(/parcel_settings_ranges/);
      await expect(set(6, 5)).rejects.toThrow(/parcel_settings_ranges/);
    });
  });
});

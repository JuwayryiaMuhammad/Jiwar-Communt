import { Client } from 'pg';
import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { residentEntry, type Credential } from '../setup/resident-entry';
import { required } from '../setup/test-env';

/**
 * The resident's phones for the entry QR (ADR 0031): issuing, listing,
 * revoking, and everything that ends a credential — each in the transaction
 * that caused it, with no pair of requests able to leave one behind.
 */
describe('Gate — entry credentials (ADR 0031)', () => {
  let h: HttpHarness;
  let w: World;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const {
    inA,
    resident,
    issueRes,
    issue,
    live,
    reasons,
    foreignCredential,
    asManager,
  } = residentEntry(() => ({ h, w, db }));

  // --------------------------------------------------------------------------
  // issuing, listing, revoking
  // --------------------------------------------------------------------------

  describe('credentials', () => {
    it('issue: the secret once, no-store; the list never shows it; the owner is told', async () => {
      const r = await resident();
      const res = await issueRes(r.token, {
        deviceName: "Mona's phone",
      }).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const c = res.body as Credential;
      expect(Object.keys(c).sort()).toEqual(['id', 'secret', 'stepSeconds']);
      expect(c.stepSeconds).toBe(30);
      expect(c.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const list = await call(w, 'GET', '/me/entry-credentials', {
        token: r.token,
      }).expect(200);
      expect(list.body).toEqual({
        data: [
          {
            id: c.id,
            deviceName: "Mona's phone",
            createdAt: expect.any(String) as string,
          },
        ],
        nextCursor: null,
      });
      expect(list.text).not.toContain(c.secret);

      // The new-device notice (normal priority, nothing about the device).
      const inbox = await call(w, 'GET', '/me/notifications', {
        token: r.token,
      }).expect(200);
      const notices = (
        inbox.body as { data: Record<string, unknown>[] }
      ).data.filter((n) => n.kind === 'entry_credential.issued');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        priority: 'normal',
        params: {},
        targetType: 'entry_credential',
        targetId: c.id,
      });
      expect(inbox.text).not.toContain("Mona's phone");
    });

    it('the secret is in no table: it is derived, never stored', async () => {
      const r = await resident();
      const c = await issue(r.token, { deviceName: 'Phone' });
      // The idempotent route too: its key row stores no body.
      const keyed = (await issueRes(r.token, {}, `scan-${c.id}`).expect(201))
        .body as Credential;
      const tables = (
        await db.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )
      ).rows as { table_name: string }[];
      expect(tables.length).toBeGreaterThan(40);
      for (const secret of [c.secret, keyed.secret]) {
        for (const { table_name: t } of tables) {
          const hits = await inA(
            `SELECT count(*) FROM "${t}" x WHERE x::text LIKE $1`,
            [`%${secret}%`],
          );
          expect({
            table: t,
            hits: Number((hits.rows[0] as { count: string }).count),
          }).toEqual({
            table: t,
            hits: 0,
          });
        }
      }
    });

    it('the limit is three live phones; revoking one frees a slot; four at once leave three', async () => {
      const r = await resident();
      const issued = [await issue(r.token), await issue(r.token)];
      issued.push(await issue(r.token));
      const fourth = await issueRes(r.token).expect(409);
      expect(err(fourth)).toMatchObject({
        code: 'ENTRY_CREDENTIAL_LIMIT_REACHED',
        params: { limit: 3 },
      });
      await call(w, 'POST', `/me/entry-credentials/${issued[0].id}/revoke`, {
        token: r.token,
      }).expect(204);
      await issue(r.token);

      const racer = await resident();
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => issueRes(racer.token)),
      );
      expect(results.map((x) => x.status).sort()).toEqual([201, 201, 201, 409]);
      expect(
        (await live(racer.id)).filter((x) => x.revoked_at === null),
      ).toHaveLength(3);
    });

    it('revoke: its owner only; revoking twice is fine; another account, another compound and an unknown id are one answer', async () => {
      const r = await resident();
      const other = await resident();
      const c = await issue(r.token);
      const theirs = await issue(other.token);
      const foreign = await foreignCredential();
      const unknown = '01a0f000-0000-7000-8000-00000000abcd';
      const answers = [];
      for (const id of [theirs.id, foreign.id, unknown]) {
        const res = await call(
          w,
          'POST',
          `/me/entry-credentials/${id}/revoke`,
          {
            token: r.token,
          },
        ).expect(404);
        answers.push(err(res).code);
      }
      expect(answers).toEqual(Array(3).fill('ENTRY_CREDENTIAL_NOT_FOUND'));
      // Nothing of theirs moved.
      expect(await reasons(other.id)).toEqual([null]);

      await call(w, 'POST', `/me/entry-credentials/${c.id}/revoke`, {
        token: r.token,
      }).expect(204);
      await call(w, 'POST', `/me/entry-credentials/${c.id}/revoke`, {
        token: r.token,
      }).expect(204);
      const [row] = await live(r.id);
      expect(row.revoke_reason).toBe('owner');
      const list = await call(w, 'GET', '/me/entry-credentials', {
        token: r.token,
      }).expect(200);
      expect((list.body as { data: unknown[] }).data).toEqual([]);
    });

    it('a retry with the same Idempotency-Key gets the same phone and secret, once', async () => {
      const r = await resident();
      const first = await issueRes(
        r.token,
        { deviceName: 'A' },
        'issue-key-1',
      ).expect(201);
      const again = await issueRes(
        r.token,
        { deviceName: 'A' },
        'issue-key-1',
      ).expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.headers['cache-control']).toBe('no-store');
      expect(again.body).toEqual(first.body);
      expect(await live(r.id)).toHaveLength(1);
      const inbox = await call(w, 'GET', '/me/notifications', {
        token: r.token,
      }).expect(200);
      expect(
        (inbox.body as { data: { kind: string }[] }).data.filter(
          (n) => n.kind === 'entry_credential.issued',
        ),
      ).toHaveLength(1);
      // The same key for another request is a conflict, not a second phone.
      const other = await issueRes(
        r.token,
        { deviceName: 'B' },
        'issue-key-1',
      ).expect(409);
      expect(err(other).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('who may: owner-resident, tenant and an active adult member; not a landlord, a guard, a manager or a member still pending', async () => {
      for (const persona of ['owner', 'tenant', 'family'] as const)
        await issueRes(w.a.tokens[persona]).expect(201);
      for (const persona of ['landlord', 'guard', 'manager'] as const) {
        const res = await issueRes(w.a.tokens[persona]).expect(403);
        expect(err(res).code).toBe('NOT_A_RESIDENT');
      }

      // A member whose join waits for approval lives nowhere yet.
      await asManager(() =>
        w.helpers.prisma.tenant.tenantSettings.update({
          where: { tenantId: w.a.tenantId },
          data: { familyJoinRequiresApproval: true },
        }),
      );
      try {
        const owner = await resident();
        const joined = await w.helpers.joinFamily(w.a, owner.unitId, owner);
        const pending = await w.tokenFor(w.a, joined.id, 'family');
        const res = await issueRes(pending).expect(403);
        expect(err(res).code).toBe('NOT_A_RESIDENT');
      } finally {
        await asManager(() =>
          w.helpers.prisma.tenant.tenantSettings.update({
            where: { tenantId: w.a.tenantId },
            data: { familyJoinRequiresApproval: false },
          }),
        );
      }
    });

    it('audit: issued and revoked name the credential and a reason, never the secret or the device', async () => {
      const r = await resident();
      const c = await issue(r.token, { deviceName: 'Secret Device Name' });
      await call(w, 'POST', `/me/entry-credentials/${c.id}/revoke`, {
        token: r.token,
      }).expect(204);
      const rows = (
        await inA(
          `SELECT action, actor_id, target_type, target_id, changes, metadata
             FROM audit_log WHERE target_id = $1 ORDER BY occurred_at, id`,
          [c.id],
        )
      ).rows as {
        action: string;
        actor_id: string;
        target_type: string;
        changes: unknown;
        metadata: unknown;
      }[];
      expect(rows.map((x) => x.action)).toEqual([
        'entry_credential.issued',
        'entry_credential.revoked',
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          actor_id: r.id,
          target_type: 'entry_credential',
        });
        const text = JSON.stringify(row);
        expect(text).not.toContain(c.secret);
        expect(text).not.toContain('Secret Device Name');
      }
      expect(rows[0].metadata).toBeNull();
      expect(rows[1].metadata).toEqual({ reasonCode: 'owner' });
    });
  });

  // --------------------------------------------------------------------------
  // everything that ends a credential
  // --------------------------------------------------------------------------

  describe('revocation', () => {
    it('"that wasn\'t me": revoking all sessions revokes every credential', async () => {
      const r = await resident();
      await issue(r.token);
      await issue(r.token);
      await call(w, 'POST', '/me/sessions/revoke-all', {
        token: r.token,
      }).expect(200);
      expect(await reasons(r.id)).toEqual([
        'sessions_revoked',
        'sessions_revoked',
      ]);
      // The session is gone: nothing can be registered with its token.
      await issueRes(r.token).expect(401);
    });

    it('freeze, deactivation and erasure revoke every credential', async () => {
      const frozen = await resident();
      await issue(frozen.token);
      await asManager(() =>
        h.moduleRef
          .get(AccountsService)
          .freeze(frozen.id, { code: 'phone_reassigned', text: 'Reported' }),
      );
      expect(await reasons(frozen.id)).toEqual(['account_frozen']);

      const inactive = await resident();
      await issue(inactive.token);
      await call(w, 'PATCH', `/accounts/${inactive.id}/status`, {
        token: w.a.tokens.manager,
        body: { status: 'inactive' },
      }).expect(200);
      expect(await reasons(inactive.id)).toEqual(['account_deactivated']);

      // A tenant beside the owner: a primary is not erased (ADR 0036).
      const erasedUnit = await w.helpers.unit(w.a);
      await w.helpers.resident(w.a, [erasedUnit.id]);
      const erasedTenant = await w.helpers.resident(
        w.a,
        [erasedUnit.id],
        'tenant',
      );
      const erased = {
        id: erasedTenant.id,
        token: await w.tokenFor(w.a, erasedTenant.id, 'resident'),
      };
      await issue(erased.token, { deviceName: 'Gone soon' });
      const deletion = h.moduleRef.get(AccountDeletionService);
      const request = await w.helpers.as(
        w.a,
        { id: erased.id, type: 'resident' },
        () => deletion.requestDeletion('DELETE'),
      );
      await asManager(() =>
        w.helpers.prisma.tenant.accountDeletionRequest.update({
          where: { id: request.id },
          data: {
            requestedAt: new Date(Date.now() - 31 * 86_400_000),
            effectiveAt: new Date(Date.now() - 86_400_000),
          },
        }),
      );
      await asManager(() => deletion.erase(request.id, scopePhrase(erased.id)));
      const [gone] = await live(erased.id);
      // The device name goes with the credential's life. An erasure
      // deactivates the account first, so that is the reason it records.
      expect(gone).toMatchObject({ device_name: null });
      expect(gone.revoked_at).toBeInstanceOf(Date);
      expect(['account_deactivated', 'account_erased']).toContain(
        gone.revoke_reason,
      );
    });

    it('moving out of the last unit revokes them; a second unit keeps them', async () => {
      const second = await w.helpers.unit(w.a);
      const r = await resident({ extraUnits: [second.id] });
      await issue(r.token);
      const occupancies = [
        ...(await w.helpers.occupancies(w.a, r.unitId)),
        ...(await w.helpers.occupancies(w.a, second.id)),
      ];
      const end = (occupancyId: string) =>
        asManager(() =>
          w.helpers.residents.endOccupancy(occupancyId, {
            code: 'moved_out',
            text: 'Left',
          }),
        );
      await end(occupancies[0].id);
      expect(await reasons(r.id)).toEqual([null]);
      await end(occupancies[1].id);
      expect(await reasons(r.id)).toEqual(['not_resident']);
    });

    it('moving out by other roads: living elsewhere, ending the household, a removed member, a sale', async () => {
      // An owner (not the primary) moves out of their home.
      const home = await resident();
      const co = await w.helpers.resident(w.a, [home.unitId]);
      await issue(await w.tokenFor(w.a, co.id, 'resident'));
      const occs = await w.helpers.occupancies(w.a, home.unitId);
      const coOcc = occs.find((o) => o.accountId === co.id)!;
      await asManager(() => w.helpers.residents.setResidence(coOcc.id, false));
      expect(await reasons(co.id)).toEqual(['not_resident']);

      // A tenant (not the primary) becomes an owner who lives elsewhere...
      const roommates = await resident();
      const tenant = await w.helpers.resident(
        w.a,
        [roommates.unitId],
        'tenant',
      );
      await issue(await w.tokenFor(w.a, tenant.id, 'resident'));
      const tenantOcc = (
        await w.helpers.occupancies(w.a, roommates.unitId)
      ).find((o) => o.accountId === tenant.id)!;
      await asManager(() =>
        w.helpers.residents.convertToOwner(tenantOcc.id, { resides: false }),
      );
      expect(await reasons(tenant.id)).toEqual(['not_resident']);

      // ...but one who still lives there keeps theirs.
      const flatmate = await w.helpers.resident(
        w.a,
        [roommates.unitId],
        'tenant',
      );
      await issue(await w.tokenFor(w.a, flatmate.id, 'resident'));
      const flatOcc = (await w.helpers.occupancies(w.a, roommates.unitId)).find(
        (o) => o.accountId === flatmate.id,
      )!;
      await asManager(() =>
        w.helpers.residents.convertToOwner(flatOcc.id, { resides: true }),
      );
      expect(await reasons(flatmate.id)).toEqual([null]);

      // The household ends: the family loses entry, and so does the primary.
      const primary = await resident();
      const joined = await w.helpers.joinFamily(w.a, primary.unitId, primary);
      const member = await w.tokenFor(w.a, joined.id, 'family');
      await issue(primary.token);
      await issue(member);
      await asManager(() =>
        w.helpers.residents.endHousehold(primary.unitId, {
          code: 'household_left',
          text: 'Left',
        }),
      );
      expect(await reasons(joined.id)).toEqual(['account_deactivated']);
      // The primary still lives there: ending the household is not leaving.
      expect(await reasons(primary.id)).toEqual([null]);

      // A removed member: their only membership ends, the account closes.
      const gone = await w.helpers.joinFamily(w.a, home.unitId, home);
      await issue(await w.tokenFor(w.a, gone.id, 'family'));
      await w.helpers.as(w.a, { id: home.id, type: 'resident' }, () =>
        h.moduleRef.get(HouseholdsService).removeMember(gone.memberId, {
          code: 'relation_ended',
          text: 'No longer',
        }),
      );
      expect(await reasons(gone.id)).toEqual(['account_deactivated']);

      // A sale: the old owner loses entry; a tenant who buys keeps theirs.
      const seller = await resident();
      const buyer = await resident({ occupancyType: 'tenant' });
      await issue(seller.token);
      await issue(buyer.token);
      await asManager(() =>
        w.helpers.residents.transferOwnership(
          seller.unitId,
          { toAccountId: buyer.id },
          { code: 'unit_changed_hands', text: 'Sold' },
        ),
      );
      expect(await reasons(seller.id)).toEqual(['not_resident']);
      expect(await reasons(buyer.id)).toEqual([null]);

      const tenantOfSale = await resident({ occupancyType: 'tenant' });
      await issue(tenantOfSale.token);
      await asManager(() =>
        w.helpers.residents.transferOwnership(
          tenantOfSale.unitId,
          { toAccountId: tenantOfSale.id },
          { code: 'unit_changed_hands', text: 'Bought it' },
        ),
      );
      expect(await reasons(tenantOfSale.id)).toEqual([null]);
    });

    it('a death review or a separation takes nothing away', async () => {
      const r = await resident();
      await issue(r.token);
      await asManager(() =>
        w.helpers.residents.markPrimaryDeceased(r.unitId, {
          code: 'deceased',
          text: 'Review',
        }),
      );
      expect(await reasons(r.id)).toEqual([null]);
    });
  });

  // --------------------------------------------------------------------------
  // races
  // --------------------------------------------------------------------------

  describe('races', () => {
    /** Holds the account row, as another transaction in flight would. */
    async function holding(accountId: string) {
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        w.a.tenantId,
      ]);
      await held.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [
        accountId,
      ]);
      return held;
    }
    const settle = async (held: Client, sql: string, params: unknown[]) => {
      await held.query(sql, params);
      await held.query('COMMIT');
      await held.end();
    };
    const waitForLockWaiter = async () => {
      for (let i = 0; i < 50; i++) {
        // pg_locks is visible to every role; pg_stat_activity hides others'.
        const waiting = await db.query(
          `SELECT count(*) FROM pg_locks WHERE NOT granted`,
        );
        if (Number((waiting.rows[0] as { count: string }).count) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the request never waited on the account lock');
    };

    it('an issue in flight when "revoke all sessions" commits registers nothing', async () => {
      const r = await resident();
      const held = await holding(r.id);
      const pending = issueRes(r.token).then((res) => res);
      await waitForLockWaiter();
      await settle(
        held,
        `UPDATE sessions SET revoked_at = now() WHERE account_id = $1`,
        [r.id],
      );
      expect((await pending).status).toBe(401);
      expect(await live(r.id)).toEqual([]);
    });

    it('an issue in flight when the person moves out registers nothing', async () => {
      const r = await resident();
      const held = await holding(r.id);
      const pending = issueRes(r.token).then((res) => res);
      await waitForLockWaiter();
      await settle(
        held,
        `UPDATE unit_occupancies
            SET status = 'ended', ended_at = now(), end_reason = 'moved_out'
          WHERE account_id = $1`,
        [r.id],
      );
      const res = await pending;
      expect(res.status).toBe(403);
      expect(err(res).code).toBe('NOT_A_RESIDENT');
      expect(await live(r.id)).toEqual([]);
    });

    it('an issue that lands first is revoked by the move that follows', async () => {
      const r = await resident();
      await issue(r.token);
      const [occ] = await w.helpers.occupancies(w.a, r.unitId);
      await asManager(() =>
        w.helpers.residents.endOccupancy(occ.id, {
          code: 'moved_out',
          text: 'Left',
        }),
      );
      expect(await reasons(r.id)).toEqual(['not_resident']);
    });
  });
});

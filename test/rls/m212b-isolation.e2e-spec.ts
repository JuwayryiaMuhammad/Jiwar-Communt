import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbDate } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  /** A technician: the rows' subject. */
  accountId: string;
  /** Who acts on the rows. */
  staffId: string;
  ticketId: string;
  consentId: string;
  reviewId: string;
  callId: string;
  slotId: string;
}

interface Table {
  table: string;
  /** The column a row is found by, when not `id`. */
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let numbers = 9000;

const ahead = (h: number) => new Date(Date.now() + h * 3_600_000);

const consent = async (tx: TenantTxClient, own: Side, link: Side) => {
  const id = newId();
  // Revoked: one live a technician, so the seeds never meet on it.
  await tx.technicianLocationConsent.create({
    data: {
      id,
      tenantId: own.tenantId,
      accountId: link.accountId,
      grantedAt: new Date(),
      revokedAt: new Date(),
      revokedBy: 'self',
    },
  });
  return id;
};

const call = async (tx: TenantTxClient, own: Side, link: Side) => {
  const id = newId();
  await tx.reinforcementCall.create({
    data: {
      id,
      tenantId: own.tenantId,
      sentById: link.staffId,
      needed: 1,
      startsAt: ahead(2),
      endsAt: ahead(3),
      recipients: 1,
      sentAt: new Date(),
    },
  });
  return id;
};

const review = async (tx: TenantTxClient, own: Side, link: Side) => {
  const id = newId();
  await tx.accessReview.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: numbers++,
      // Closed: one open a compound, so the seeds never meet on it.
      status: 'closed',
      openedAt: new Date(),
      openedById: link.staffId,
      lines: 0,
      closedAt: new Date(),
    },
  });
  return id;
};

/**
 * The tables of the field team's part b (ADR 0090): isolated like every
 * other tenant table, linked with composite keys.
 */
const TABLES: Table[] = [
  { table: 'technician_location_consents', insert: consent },
  {
    table: 'technician_locations',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.technicianLocation.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.accountId,
          consentId: link.consentId,
          ticketId: link.ticketId,
          moment: 'started',
          latitude: 30,
          longitude: 31,
          capturedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'staff_certificates',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.staffCertificate.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.accountId,
          kind: 'electrical',
          title: 'Licence',
          expiresOn: dbDate('2030-01-01'),
          addedById: link.staffId,
          addedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'account_check_settings',
    key: 'tenant_id',
    insert: async (tx, own, link) => {
      await tx.accountCheckSettings.create({
        data: { tenantId: own.tenantId, updatedById: link.staffId },
      });
      return own.tenantId;
    },
  },
  {
    table: 'dangling_account_findings',
    insert: async (tx, own, link) => {
      const id = newId();
      // Cleared: one open an account, so the seeds never meet on it.
      await tx.danglingAccountFinding.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.accountId,
          reason: 'idle',
          foundAt: new Date(),
          status: 'cleared',
          clearedAt: new Date(),
        },
      });
      return id;
    },
  },
  { table: 'access_reviews', insert: review },
  {
    table: 'access_review_lines',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.accessReviewLine.create({
        data: {
          id,
          tenantId: own.tenantId,
          reviewId: link.reviewId,
          accountId: link.accountId,
          accountType: 'staff',
          roleId: newId(),
          permissions: [],
        },
      });
      return id;
    },
  },
  {
    table: 'reinforcement_suggestions',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.reinforcementSuggestion.create({
        data: {
          id,
          tenantId: own.tenantId,
          raisedAt: new Date(),
          openTickets: 3,
          available: 1,
          threshold: 2,
          createdAt: new Date(),
          status: 'dismissed',
          decidedAt: new Date(),
          decidedById: link.staffId,
          reasonCode: 'other',
        },
      });
      return id;
    },
  },
  { table: 'reinforcement_calls', insert: call },
  {
    table: 'reinforcement_call_recipients',
    key: 'call_id',
    insert: async (tx, own, link) => {
      const callId = own === link ? await call(tx, own, own) : link.callId;
      await tx.reinforcementCallRecipient.create({
        data: { tenantId: own.tenantId, callId, accountId: link.accountId },
      });
      return callId;
    },
  },
];

describe('RLS isolation — the field team, part b (ADR 0090)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Field team b ${label}`);
    const unit = await createUnit(h, tenantId);
    const s = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId, 'staff')).id,
      staffId: (await createAccountRow(h, tenantId, 'staff')).id,
    } as Side;
    await inTenant(s, async (tx) => {
      const category = await tx.ticketCategory.findFirstOrThrow({
        where: { key: 'plumbing' },
      });
      s.ticketId = newId();
      await tx.ticket.create({
        data: {
          id: s.ticketId,
          tenantId,
          number: numbers++,
          unitId: unit.id,
          categoryId: category.id,
          createdById: s.staffId,
          reporterId: s.staffId,
          priority: 'normal',
          description: 'Fixture',
        },
      });
      s.consentId = await consent(tx, s, s);
      s.reviewId = await review(tx, s, s);
      s.callId = await call(tx, s, s);
    });
    return s;
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270614090000' && m < '20270615')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    const key = t.key ?? 'id';
    it('A sees its row; B does not, by its key or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `"${key}" = $1::uuid`}`,
            all ? a.tenantId : ids[name],
          );
          return Number(rows[0].n);
        });
      expect(await count(a)).toBeGreaterThanOrEqual(1);
      expect(await count(b)).toBe(0);
      expect(await count(b, true)).toBe(0);
    });

    it('B updates and deletes nothing of A', async () => {
      const run = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
            ),
        );
      expect(
        await run(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE "${key}" = $1::uuid`)).toBe(
        0,
      );
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
        /row-level security/,
      );
    });

    // The settings' key is the compound itself: a second row of A's is
    // refused as a duplicate before its keys are looked at.
    if (name !== 'account_check_settings')
      it('a row may not point at another compound’s rows (composite keys)', async () => {
        await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { daysLater, dbClock } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { marketFileRow } from '../setup/market-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  vendorId: string;
  ticketId: string;
  tenderId: string;
  invitationId: string;
}

interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let numbers = 7000;
const later = () => daysLater(30);

/**
 * The tables of ADR 0088: isolated like every other tenant table, linked
 * with composite keys. The bid links are global (rls-coverage lists them);
 * a bid is inserted as the app inserts it, its amount into the seal.
 */
const TABLES: Table[] = [
  {
    table: 'ticket_vendor_dispatches',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketVendorDispatch.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          vendorId: link.vendorId,
          cycle: 1,
          status: 'declined',
          offeredById: link.accountId,
          offeredAt: dbClock(),
          decidedById: link.accountId,
          decidedAt: dbClock(),
          declineReason: 'no_capacity',
        },
      });
      return id;
    },
  },
  {
    table: 'tenders',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.tender.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: ++numbers,
          title: 'Isolated works',
          category: 'maintenance',
          contractKind: 'service',
          bidsDueAt: later(),
          createdById: link.accountId,
          createdAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'tender_documents',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.tenderDocument.create({
        data: {
          id,
          tenantId: own.tenantId,
          tenderId: link.tenderId,
          fileId: await marketFileRow(tx, own.tenantId, 'tender_document'),
          title: 'Scope',
          addedById: link.accountId,
          addedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'tender_invitations',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.tenderInvitation.create({
        data: {
          id,
          tenantId: own.tenantId,
          tenderId: link.tenderId,
          kind: 'vendor',
          vendorId: link.vendorId,
          invitedById: link.accountId,
          invitedAt: dbClock(),
          revokedById: link.accountId,
          revokedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'tender_bids',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.$executeRaw`
        INSERT INTO tender_bids
          (id, tenant_id, tender_id, invitation_id, submitted_by_account_id,
           submitted_at, sealed_amount)
        VALUES (${id}::uuid, ${own.tenantId}::uuid, ${link.tenderId}::uuid,
                ${link.invitationId}::uuid, ${link.accountId}::uuid,
                ${dbClock()}, 100::numeric)`;
      return id;
    },
  },
];

describe('RLS isolation — the contractor portal and tenders (ADR 0088)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Tenders ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      vendorId: newId(),
      ticketId: newId(),
      tenderId: newId(),
      invitationId: newId(),
    };
    await inTenant(s, async (tx) => {
      await tx.vendor.create({
        data: {
          id: s.vendorId,
          tenantId,
          number: ++numbers,
          name: `Tenders ${s.vendorId}`,
        },
      });
      const category = await tx.ticketCategory.findFirstOrThrow({
        where: { commonAreaAllowed: true },
      });
      await tx.ticket.create({
        data: {
          id: s.ticketId,
          tenantId,
          number: ++numbers,
          commonArea: 'Lobby',
          categoryId: category.id,
          createdById: s.accountId,
          reporterId: s.accountId,
          priority: 'normal',
          description: 'Isolated ticket',
        },
      });
      await tx.tender.create({
        data: {
          id: s.tenderId,
          tenantId,
          number: ++numbers,
          title: 'Isolated tender',
          category: 'maintenance',
          contractKind: 'service',
          bidsDueAt: later(),
          createdById: s.accountId,
          createdAt: dbClock(),
        },
      });
      await tx.tenderInvitation.create({
        data: {
          id: s.invitationId,
          tenantId,
          tenderId: s.tenderId,
          kind: 'link',
          companyName: 'Isolated Co.',
          invitedById: s.accountId,
          invitedAt: dbClock(),
        },
      });
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

  it('covers every tenant table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270608090000' && m < '20270609')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      )
      // Global, like the desk links (ADR 0060): rls-coverage lists it.
      .filter((t) => t !== 'tender_bid_links');
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  it('a bid’s seal is never the app’s to read, in any compound', async () => {
    await expect(
      inTenant(
        a,
        (tx) => tx.$queryRaw`SELECT sealed_amount FROM tender_bids LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inTenant(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE tender_bids SET amount = 1 WHERE id = ${ids.tender_bids}::uuid`,
      ),
    ).rejects.toThrow(/never written plain|permission denied/);
  });

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    it('A sees its row; B does not, by its key or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `id = $1::uuid`}`,
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
              /permission denied|keeps|never|moves forward|once/.test(e.message)
                ? 0
                : Promise.reject(e),
            ),
        );
      expect(
        await run(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE id = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE id = $1::uuid`)).toBe(0);
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
        /row-level security/,
      );
    });

    it('a row may not point at another compound’s rows (composite keys)', async () => {
      await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });
  });
});

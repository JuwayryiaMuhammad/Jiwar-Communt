import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  residentId: string;
  unitId: string;
  topicId: string;
}

/**
 * One table of the office queue: how to insert a row in a compound. `link`
 * points the row's foreign keys at another compound's rows, which the
 * composite keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

const suffix = () => newId().slice(-8);

/** The global pointer is no tenant table (the RLS coverage suite lists it). */
const GLOBAL = ['official_letter_links'];

/**
 * The tables of announcements and the office queue (ADR 0080): isolated
 * like every other tenant table, linked with composite keys. The RLS
 * coverage test checks the policies exist; this suite checks they hold,
 * table by table.
 */
const TABLES: Table[] = [
  {
    table: 'announcement_templates',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.announcementTemplate.create({
        data: {
          id,
          tenantId: own.tenantId,
          name: `T ${suffix()}`,
          titleEn: 'Water cut',
          bodyEn: 'The water is off.',
          createdById: link.staffId,
        },
      });
      return id;
    },
  },
  {
    table: 'request_reply_templates',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.requestReplyTemplate.create({
        data: {
          id,
          tenantId: own.tenantId,
          topicId: link.topicId,
          name: `R ${suffix()}`,
          bodyEn: 'Your letter is ready.',
          createdById: link.staffId,
        },
      });
      return id;
    },
  },
  {
    table: 'official_letter_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.officialLetterCounter.create({
        data: { tenantId: own.tenantId, lastNumber: 1 },
      });
      return own.tenantId;
    },
  },
  {
    table: 'official_letters',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.officialLetter.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: Number.parseInt(suffix(), 16) % 1_000_000 || 1,
          kind: 'residence_confirmation',
          unitId: link.unitId,
          accountId: link.residentId,
          subjectName: 'Isolated Resident',
          occupancyType: 'owner',
          occupancySince: new Date('2026-01-01T00:00:00Z'),
          issuedById: link.staffId,
          issuedAt: new Date(),
          verifyCode: newId().replace(/-/g, '').slice(0, 22),
          template: 'certificate.v2',
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — announcements and the office queue (ADR 0080)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Office queue ${label}`);
    const staff = await createAccountRow(h, tenantId, 'manager');
    const resident = await createAccountRow(h, tenantId, 'resident');
    const { unitId, topicId } = await inTenant({ tenantId }, async (tx) => {
      const unitId = newId();
      await tx.unit.create({
        data: { id: unitId, tenantId, code: `OQ-${suffix()}` },
      });
      const topicId = newId();
      await tx.managementRequestTopic.create({
        data: {
          id: topicId,
          tenantId,
          key: `t_${suffix()}`,
          nameAr: 'خطابات',
          nameEn: 'Letters',
          targetResponseHours: 72,
        },
      });
      return { unitId, topicId };
    });
    return {
      tenantId,
      staffId: staff.id,
      residentId: resident.id,
      unitId,
      topicId,
    };
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  }, 60_000);

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270323090000' && m < '20270324')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ]
          .map((x) => x[1])
          .filter((t) => !GLOBAL.includes(t)),
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
      expect(await count(a)).toBe(1);
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

    if (t.linked !== false) {
      it('a row may not point at another compound’s rows (composite keys)', async () => {
        await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
    }
  });
});

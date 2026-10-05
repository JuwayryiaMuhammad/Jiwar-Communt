import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  staffId: string;
  /** One of the compound's seeded categories. */
  categoryId: string;
  /** A ticket of the compound, for the rows that hang off one. */
  ticketId: string;
}

/**
 * One maintenance table: how to insert a row in a compound. `link` points
 * the row's foreign keys at another compound's rows, which the composite
 * keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  linked?: boolean;
}

let numbers = 1000;

async function ticket(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.ticket.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: numbers++,
      unitId: link.unitId,
      categoryId: link.categoryId,
      createdById: link.accountId,
      reporterId: link.accountId,
      priority: 'normal',
      description: 'Fixture',
    },
  });
  return id;
}

/** A ready file attached to nothing yet, of the row's own compound. */
async function attachedFile(tx: TenantTxClient, tenantId: string) {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose: 'ticket_photo',
      contentType: 'image/jpeg',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

/**
 * Maintenance tenant tables (ADR 0032, 0033, 0034): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'ticket_categories',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.ticketCategory.create({
        data: {
          id,
          tenantId: own.tenantId,
          key: `k_${id.slice(-8)}`,
          nameAr: 'فئة',
          nameEn: 'Category',
        },
      });
      return id;
    },
  },
  {
    // One row per compound, already there: an upsert that RLS must refuse
    // for another compound.
    table: 'maintenance_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.maintenanceSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'ticket_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.ticketCounter.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  { table: 'tickets', insert: ticket },
  {
    table: 'ticket_feedback',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketFeedback.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          kind: 'rejected',
          authorId: link.accountId,
          reasonCode: 'not_fixed',
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_messages',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketMessage.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          senderId: link.accountId,
          body: 'Fixture',
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_attachments',
    insert: async (tx, own, link) => {
      const id = newId();
      // The file is always the row's own (a foreign one fails the same way).
      await tx.ticketAttachment.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          fileId: await attachedFile(tx, own.tenantId),
          kind: 'report',
          uploadedById: link.accountId,
          cycle: 1,
        },
      });
      return id;
    },
  },
  {
    // Append-only and without foreign keys, like gate_entries.
    table: 'ticket_status_history',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketStatusHistory.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          toStatus: 'new',
          actorId: link.accountId,
          cycle: 1,
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_assignments',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketAssignment.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          toId: link.staffId,
          assignedById: link.accountId,
          assignmentType: 'manual',
          cycle: 1,
        },
      });
      return id;
    },
  },
  // Dispatch (ADR 0033).
  {
    table: 'specialties',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.specialty.create({
        data: {
          id,
          tenantId: own.tenantId,
          key: `s_${id.slice(-8)}`,
          nameAr: 'تخصص',
          nameEn: 'Specialty',
        },
      });
      return id;
    },
  },
  {
    // The category is the link's; the specialty is always the row's own.
    table: 'category_specialties',
    key: 'specialty_id',
    insert: async (tx, own, link) => {
      const specialtyId = newId();
      await tx.specialty.create({
        data: {
          id: specialtyId,
          tenantId: own.tenantId,
          key: `c_${specialtyId.slice(-8)}`,
          nameAr: 'تخصص',
          nameEn: 'Specialty',
        },
      });
      await tx.categorySpecialty.create({
        data: {
          tenantId: own.tenantId,
          categoryId: link.categoryId,
          specialtyId,
        },
      });
      return specialtyId;
    },
  },
  {
    table: 'technician_specialties',
    key: 'specialty_id',
    insert: async (tx, own, link) => {
      const specialtyId = newId();
      await tx.specialty.create({
        data: {
          id: specialtyId,
          tenantId: own.tenantId,
          key: `t_${specialtyId.slice(-8)}`,
          nameAr: 'تخصص',
          nameEn: 'Specialty',
        },
      });
      await tx.technicianSpecialty.create({
        data: {
          tenantId: own.tenantId,
          accountId: link.staffId,
          specialtyId,
        },
      });
      return specialtyId;
    },
  },
  {
    table: 'technician_availability',
    key: 'account_id',
    insert: async (tx, own, link) => {
      await tx.technicianAvailability.create({
        data: {
          tenantId: own.tenantId,
          accountId: link.staffId,
          state: 'available',
        },
      });
      return link.staffId;
    },
  },
  {
    table: 'technician_availability_history',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.technicianAvailabilityHistory.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.staffId,
          toState: 'available',
          changedById: link.staffId,
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_dispatch_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.maintenanceDispatchSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'ticket_dispatch_attempts',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketDispatchAttempt.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          trigger: 'created',
          outcome: 'no_candidate',
          candidateCount: 0,
        },
      });
      return id;
    },
  },
  // Visits and the SLA (ADR 0034).
  {
    table: 'ticket_visits',
    insert: async (tx, own, link) => {
      const id = newId();
      const startsAt = new Date(Date.now() + 86_400_000);
      await tx.ticketVisit.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          technicianId: link.staffId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          proposedBySide: 'technician',
          proposedById: link.staffId,
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_visit_events',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketVisitEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          visitId: newId(),
          ticketId: link.ticketId,
          kind: 'proposed',
          actorSide: 'technician',
          actorId: link.staffId,
          at: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_sla_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.maintenanceSlaSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    // Every category already has its three targets: the row's own is a
    // new category; a link points at the other compound's seeded one.
    table: 'sla_targets',
    key: 'category_id',
    insert: async (tx, own, link) => {
      let categoryId = link.categoryId;
      if (link.tenantId === own.tenantId) {
        categoryId = newId();
        await tx.ticketCategory.create({
          data: {
            id: categoryId,
            tenantId: own.tenantId,
            key: `sla_${categoryId.slice(-8)}`,
            nameAr: 'فئة',
            nameEn: 'Category',
          },
        });
      }
      await tx.slaTarget.create({
        data: {
          tenantId: own.tenantId,
          categoryId,
          priority: 'normal',
          responseMinutes: 60,
          resolutionMinutes: 600,
        },
      });
      return categoryId;
    },
  },
  {
    table: 'ticket_sla_events',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketSlaEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          clock: 'response',
          seq: 1,
          kind: 'started',
          at: new Date(),
          targetMinutes: 60,
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_sla_clocks',
    key: 'ticket_id',
    insert: async (tx, own, link) => {
      const now = new Date();
      await tx.ticketSlaClock.create({
        data: {
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          clock: 'response',
          state: 'running',
          targetMinutes: 60,
          startedAt: now,
          dueAt: new Date(now.getTime() + 3_600_000),
          lastSeq: 1,
        },
      });
      return link.ticketId;
    },
  },
];

describe('RLS isolation — maintenance tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Maintenance ${label}`);
    const unit = await createUnit(h, tenantId);
    const account = await createAccountRow(h, tenantId, 'resident');
    const staff = await createAccountRow(h, tenantId, 'staff');
    const category = await inTenant({ tenantId }, (tx) =>
      tx.ticketCategory.findFirstOrThrow({ where: { key: 'plumbing' } }),
    );
    const s: Side = {
      tenantId,
      unitId: unit.id,
      accountId: account.id,
      staffId: staff.id,
      categoryId: category.id,
      ticketId: '',
    };
    s.ticketId = await inTenant(s, (tx) => ticket(tx, s, s));
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

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    const key = t.key ?? 'id';

    it('A sees its row; B does not, by id or in a full scan', async () => {
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
      // No DELETE for the app here, and the history refuses UPDATE too:
      // both are also nothing.
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

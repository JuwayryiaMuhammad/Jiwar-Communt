import { lockUnits } from '../../src/community/units/unit-lock';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** A promise and the function that resolves it. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe('the unit lock (ADR 0016, 0044)', () => {
  let h: DbHarness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createDbHarness({ poolMax: 4 });
    tenantId = await createTenant(h, 'Unit lock');
  });
  afterAll(() => h.close());

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  it('a write that names a locked unit does not wait on the lock, so it cannot deadlock with the holder', async () => {
    // The shape that deadlocked: a writer holds its author's account row
    // (lockSelf) and inserts a row naming the unit; meanwhile the holder of
    // the unit lock reaches for that same account (removing a member,
    // ending an occupancy). Under `FOR UPDATE` the insert's foreign-key
    // check waited on the unit and the holder waited on the account.
    const unit = await createUnit(h, tenantId);
    const account = await createAccountRow(h, tenantId);
    const authorLocked = gate();
    const unitLocked = gate();

    const writer = inTx(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM accounts WHERE id = ${account.id}::uuid FOR SHARE`;
      authorLocked.open();
      await unitLocked.opened;
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`
        INSERT INTO unit_review_flags (id, tenant_id, unit_id, reason)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${unit.id}::uuid, 'primary_left')`;
    });
    const holder = inTx(async (tx) => {
      await authorLocked.opened;
      await lockUnits(tx, [unit.id]);
      unitLocked.open();
      await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
      await tx.$queryRaw`
        SELECT id FROM accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
    });

    const outcome = await Promise.allSettled([writer, holder]);
    expect(outcome.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const flags = await inTx((tx) =>
      tx.unitReviewFlag.count({ where: { unitId: unit.id } }),
    );
    expect(flags).toBe(1);
  });

  it('two holders of the same unit still wait for each other', async () => {
    const unit = await createUnit(h, tenantId);
    const first = gate();
    const release = gate();
    const holding = inTx(async (tx) => {
      await lockUnits(tx, [unit.id]);
      first.open();
      await release.opened;
    });
    await first.opened;
    const second = inTx(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
      await lockUnits(tx, [unit.id]);
    });
    await expect(second).rejects.toThrow(/lock timeout/i);
    release.open();
    await holding;
  });
});

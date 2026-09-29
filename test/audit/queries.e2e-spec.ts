import type { AuditLog } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import {
  AuditQueryService,
  PlatformAuditQueryService,
  SecurityEventsQueryService,
} from '../../src/audit/audit-query.service';
import type { AppClsStore } from '../../src/common/cls/app-cls';
import { newId } from '../../src/common/uuid';
import { GlobalDbService } from '../../src/database/global-db.service';
import { PrismaService } from '../../src/database/prisma.service';
import { TenantTx } from '../../src/database/tenant-tx.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** Query services for future screens: filters, cursors, RLS. */
describe('Audit queries', () => {
  let h: HttpHarness;
  let cls: ClsService<AppClsStore>;
  let queries: AuditQueryService;
  let tenantA: { id: string; name: string };
  let tenantB: { id: string; name: string };
  const actorA = newId();
  const targetX = newId();
  const base = new Date('2026-09-01T10:00:00.000Z');
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
  let entries: AuditLog[] = [];

  beforeAll(async () => {
    h = await createHttpHarness();
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    queries = h.moduleRef.get(AuditQueryService);
    tenantA = await h.createTenant('Query A');
    tenantB = await h.createTenant('Query B');

    // Nine entries in A; three share one timestamp to exercise tie-breaks.
    const minutes = [0, 1, 2, 2, 2, 3, 4, 5, 6];
    entries = await inTenant(tenantA.id, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const out: AuditLog[] = [];
        for (const [i, m] of minutes.entries()) {
          out.push(
            await tx.auditLog.create({
              data: {
                id: newId(),
                tenantId: tenantA.id,
                occurredAt: at(m),
                actorType: i % 2 ? 'account' : 'system',
                actorId: i % 2 ? actorA : null,
                action: i < 4 ? 'unit.created' : 'occupancy.created',
                targetType: i < 4 ? 'unit' : 'occupancy',
                targetId: i === 5 ? targetX : newId(),
              },
            }),
          );
        }
        return out;
      }),
    );
    await inTenant(tenantB.id, () =>
      h.moduleRef.get(PrismaService).tenant.auditLog.create({
        data: {
          id: newId(),
          tenantId: tenantB.id,
          occurredAt: at(3),
          actorType: 'system',
          action: 'unit.created',
          targetType: 'unit',
        },
      }),
    );
  });

  afterAll(() => h.close());

  function inTenant<T>(tenantId: string, fn: () => Promise<T>) {
    return cls.run(async () => {
      cls.set('tenantId', tenantId);
      return await fn();
    });
  }

  const window = { from: at(0), to: at(60) };
  const newestFirst = () =>
    [...entries].sort(
      (a, b) =>
        b.occurredAt.getTime() - a.occurredAt.getTime() ||
        (a.id < b.id ? 1 : -1),
    );

  it('pages newest first with no gaps or duplicates, even on equal timestamps', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await inTenant(tenantA.id, () =>
        queries.list({ ...window, limit: 2, cursor }),
      );
      seen.push(...page.items.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(newestFirst().map((e) => e.id));
  });

  it('filters by action, actor, target and time', async () => {
    const list = (q: Parameters<AuditQueryService['list']>[0]) =>
      inTenant(tenantA.id, () => queries.list({ ...window, ...q })).then(
        (p) => p.items,
      );

    expect(
      (await list({ action: 'unit.created' })).map((e) => e.action),
    ).toEqual(Array(4).fill('unit.created'));
    expect(
      (await list({ actorId: actorA })).every((e) => e.actorId === actorA),
    ).toBe(true);
    expect(
      (await list({ targetType: 'occupancy', targetId: targetX })).map(
        (e) => e.id,
      ),
    ).toEqual([entries[5].id]);
    expect(await list({ from: at(2), to: at(3) })).toHaveLength(3);
  });

  it('is scoped to the current compound (RLS)', async () => {
    const page = await inTenant(tenantB.id, () => queries.list(window));
    expect(page.items.every((e) => e.tenantId === tenantB.id)).toBe(true);
    expect(page.items.map((e) => e.id)).not.toContain(entries[0].id);
  });

  it('clamps the limit', async () => {
    const many = await inTenant(tenantA.id, () =>
      queries.list({ ...window, limit: 1000 }),
    );
    expect(many.items).toHaveLength(9);
    const one = await inTenant(tenantA.id, () =>
      queries.list({ ...window, limit: 0 }),
    );
    expect(one.items).toHaveLength(1);
    expect(one.nextCursor).not.toBeNull();
  });

  it('rejects a malformed cursor with a field code', async () => {
    for (const cursor of [
      'not-base64!',
      Buffer.from('["x","y"]').toString('base64url'),
    ]) {
      await expect(
        inTenant(tenantA.id, () => queries.list({ cursor })),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        response: expect.objectContaining({
          fields: [{ field: 'cursor', code: 'INVALID_FORMAT' }],
        }) as unknown,
      });
    }
  });

  it('platform log and security events page and filter the same way', async () => {
    const globalDb = h.moduleRef.get(GlobalDbService);
    const tenantId = newId();
    for (const m of [0, 1, 1, 2]) {
      await globalDb.platformAuditLog.create({
        data: {
          id: newId(),
          occurredAt: at(100 + m),
          actorType: 'system',
          action: 'tenant.created',
          targetType: 'tenant',
          targetTenantId: tenantId,
        },
      });
      await globalDb.securityEvent.create({
        data: {
          id: newId(),
          occurredAt: at(100 + m),
          event: 'otp.requested',
          tenantId,
        },
      });
    }
    const platform = h.moduleRef.get(PlatformAuditQueryService);
    const first = await platform.list({ targetTenantId: tenantId, limit: 3 });
    expect(first.items).toHaveLength(3);
    const rest = await platform.list({
      targetTenantId: tenantId,
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();

    const events = await h.moduleRef
      .get(SecurityEventsQueryService)
      .list({ tenantId, event: 'otp.requested' });
    expect(events.items).toHaveLength(4);
  });
});

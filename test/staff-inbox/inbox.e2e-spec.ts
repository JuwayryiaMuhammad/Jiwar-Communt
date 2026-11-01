import { newId } from '../../src/core/common/uuid';
import { INBOX_OVERDUE_SWEEP } from '../../src/core/staff-inbox/staff-inbox.service';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { batchRow, invoiceRow } from '../setup/finance-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { topicRow } from '../setup/management-rows';
import { neighboursHelpers, type NeighboursSetUp } from '../setup/neighbours';
import { permitRow } from '../setup/permits-rows';

const HOUR = 3_600_000;
/** Numbers unique in the suite's own compound. */
let seq = 0;

interface Item {
  type: string;
  id: string;
  number: string | null;
  kind: string | null;
  status: string;
  unitId: string | null;
  requestedAt: string;
  dueAt: string;
  overdue: boolean;
  amount: string | null;
  authority: { limit: string | null; decider: string } | null;
  bulk: boolean;
}

/**
 * ADR 0073: the staff inbox. One queue over what waits for a staff decision
 * across the domains, oldest first, each type to its own permission's
 * holders, with its due time; the compound's own due times; a bulk approval
 * through each domain's own approve; and the overdue notice, once per item.
 */
describe('Staff inbox', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    // ADR 0074: a new compound's works wait for their deposit; this suite's
    // permits are about the inbox.
    await n.inTx(s.c, (tx) =>
      tx.permitSettings.update({
        where: { tenantId: s.c.tenantId },
        data: { worksDepositRequired: false },
      }),
    );
  }, 180_000);

  afterAll(() => h.close());

  const inTx = <T>(fn: (tx: TenantTxClient) => Promise<T>) => n.inTx(s.c, fn);

  /** Waiting since `hoursAgo` hours ago. */
  const ago = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);

  async function pendingPermit(hoursAgo: number): Promise<string> {
    return inTx(async (tx) => {
      return permitRow(tx, {
        tenantId: s.c.tenantId,
        unitId: s.homeA.id,
        requestedById: s.alice.id,
        data: { createdAt: ago(hoursAgo) },
      });
    });
  }

  async function pendingVehicle(hoursAgo: number): Promise<string> {
    return inTx(async (tx) => {
      const id = newId();
      await tx.vehicle.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 700_000 + ++seq,
          unitId: s.homeA.id,
          registeredById: s.alice.id,
          plate: `INB ${id.slice(-6)}`,
          makeAndModel: 'Inbox car',
          color: 'Grey',
          type: 'car',
          createdAt: ago(hoursAgo),
        },
      });
      return id;
    });
  }

  async function pendingRequest(hoursAgo: number): Promise<string> {
    return inTx(async (tx) => {
      const topicId = await topicRow(tx, s.c.tenantId);
      const id = newId();
      const at = ago(hoursAgo);
      await tx.managementRequest.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 600_000 + ++seq,
          type: 'question',
          topicId,
          authorId: s.bob.id,
          cycleStartedAt: at,
          responseDueAt: new Date(at.getTime() + HOUR),
          lastActivityAt: at,
          createdAt: at,
        },
      });
      return id;
    });
  }

  async function pendingNameChange(hoursAgo: number): Promise<string> {
    return inTx(async (tx) => {
      const id = newId();
      await tx.accountIdentityChange.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          accountId: s.bob.id,
          field: 'name',
          newValue: 'Bob Renamed',
          createdAt: ago(hoursAgo),
        },
      });
      return id;
    });
  }

  const list = async (path: string, token = s.manager.token) =>
    (
      (
        await n
          .http(
            'get',
            `${path}${path.includes('?') ? '&' : '?'}limit=100`,
            token,
          )
          .expect(200)
      ).body as { data: Item[] }
    ).data;

  const mine = (items: Item[], ids: string[]) =>
    items.filter((i) => ids.includes(i.id));

  it('every type its permission’s holders decide, oldest first, with its reference, its age and its due time', async () => {
    const vehicle = await pendingVehicle(30);
    const permit = await pendingPermit(20);
    const request = await pendingRequest(10);
    const ids = [vehicle, permit, request];
    const all = mine(await list('/staff/inbox'), ids);
    expect(all.map((i) => [i.type, i.id])).toEqual([
      ['vehicle', vehicle],
      ['unit_permit', permit],
      ['management_request', request],
    ]);
    const [v, p, r] = all;
    expect(v).toMatchObject({
      status: 'pending',
      kind: 'car',
      unitId: s.homeA.id,
      overdue: false,
      authority: null,
      bulk: false,
    });
    expect(v.number).toMatch(/^VH-\d{6}$/);
    expect(
      new Date(v.dueAt).getTime() - new Date(v.requestedAt).getTime(),
    ).toBe(72 * HOUR);
    expect(p).toMatchObject({ kind: 'works', bulk: true });
    expect(p.number).toMatch(/^W-\d{4,}$/);
    expect(r).toMatchObject({ status: 'open', kind: 'question' });
    expect(r.number).toMatch(/^MR-\d{6}$/);
    // One type only.
    expect(
      mine(await list('/staff/inbox?type=unit_permit'), ids).map((i) => i.id),
    ).toEqual([permit]);
  });

  it('a staff member sees only the types whose permission they hold; a resident is refused', async () => {
    const permit = await pendingPermit(5);
    const vehicle = await pendingVehicle(5);
    const gatekeeper = await n.staff(s.c, ['inbox.read', 'permits.manage']);
    const seen = mine(await list('/staff/inbox', gatekeeper.token), [
      permit,
      vehicle,
    ]);
    expect(seen.map((i) => i.id)).toEqual([permit]);
    const count = (
      (await n.http('get', '/staff/inbox/count', gatekeeper.token).expect(200))
        .body as { types: { type: string }[] }
    ).types;
    expect(count.map((t) => t.type)).toEqual(['unit_permit']);
    await n.http('get', '/staff/inbox', s.alice.token).expect(403);
  });

  it('due times: the compound sets its own per type, null goes back to the default; past it an item is overdue', async () => {
    const late = await pendingPermit(3);
    const fresh = await pendingPermit(0);
    const before = (
      (await n.http('get', '/staff/inbox/count', s.manager.token).expect(200))
        .body as { types: { type: string; total: number; overdue: number }[] }
    ).types.find((t) => t.type === 'unit_permit')!;
    const set = (
      (
        await n
          .http('patch', '/staff/inbox/settings', s.manager.token, {
            items: [{ type: 'unit_permit', dueHours: 2 }],
          })
          .expect(200)
      ).body as { data: { type: string; dueHours: number; custom: boolean }[] }
    ).data.find((r) => r.type === 'unit_permit');
    expect(set).toMatchObject({ dueHours: 2, custom: true });
    const overdue = await list('/staff/inbox?overdue=true&type=unit_permit');
    expect(overdue.map((i) => i.id)).toContain(late);
    expect(overdue.map((i) => i.id)).not.toContain(fresh);
    expect(overdue.find((i) => i.id === late)!.overdue).toBe(true);
    const after = (
      (await n.http('get', '/staff/inbox/count', s.manager.token).expect(200))
        .body as { types: { type: string; total: number; overdue: number }[] }
    ).types.find((t) => t.type === 'unit_permit')!;
    expect(after.overdue).toBeGreaterThan(before.overdue);
    // Back to the default.
    const reset = (
      (
        await n
          .http('patch', '/staff/inbox/settings', s.manager.token, {
            items: [{ type: 'unit_permit', dueHours: null }],
          })
          .expect(200)
      ).body as { data: { type: string; dueHours: number; custom: boolean }[] }
    ).data.find((r) => r.type === 'unit_permit');
    expect(reset).toMatchObject({ dueHours: 24, custom: false });
    // A range, a duplicate, a staff member without settings.manage.
    for (const items of [
      [{ type: 'unit_permit', dueHours: 0 }],
      [{ type: 'unit_permit', dueHours: 721 }],
      [
        { type: 'vehicle', dueHours: 5 },
        { type: 'vehicle', dueHours: 6 },
      ],
    ])
      await n
        .http('patch', '/staff/inbox/settings', s.manager.token, { items })
        .expect(400);
    await n
      .http('patch', '/staff/inbox/settings', s.handler.token, {
        items: [{ type: 'vehicle', dueHours: 5 }],
      })
      .expect(403);
  });

  it('a bulk approval goes through each domain’s own approve; one refused leaves the others; a type with input is refused whole', async () => {
    const permit = await pendingPermit(1);
    const change = await pendingNameChange(1);
    const outcomes = (
      (
        await n
          .http('post', '/staff/inbox/bulk-approve', s.manager.token, {
            items: [
              { type: 'unit_permit', id: permit },
              { type: 'identity_change', id: change },
            ],
          })
          .expect(200)
      ).body as { data: { id: string; outcome: string; code: string | null }[] }
    ).data;
    expect(outcomes.map((o) => [o.id, o.outcome])).toEqual([
      [permit, 'approved'],
      [change, 'approved'],
    ]);
    expect(
      await inTx((tx) =>
        tx.unitPermit.findUniqueOrThrow({ where: { id: permit } }),
      ),
    ).toMatchObject({ status: 'approved' });
    // Again: the permit's own refusal, item by item.
    const again = (
      (
        await n
          .http('post', '/staff/inbox/bulk-approve', s.manager.token, {
            items: [{ type: 'unit_permit', id: permit }],
          })
          .expect(200)
      ).body as { data: { outcome: string; code: string | null }[] }
    ).data;
    expect(again).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        code: 'PERMIT_NOT_PENDING',
      }),
    ]);
    // A vehicle's approval needs its sticker: not in bulk.
    const vehicle = await pendingVehicle(1);
    const refused = (
      await n
        .http('post', '/staff/inbox/bulk-approve', s.manager.token, {
          items: [{ type: 'vehicle', id: vehicle }],
        })
        .expect(400)
    ).body as { fields: { field: string; code: string }[] };
    expect(refused.fields).toEqual([
      expect.objectContaining({
        field: 'items[0].type',
        code: 'INVALID_VALUE',
      }),
    ]);
    // A type the caller does not decide.
    const gatekeeper = await n.staff(s.c, ['inbox.read', 'permits.manage']);
    await n
      .http('post', '/staff/inbox/bulk-approve', gatekeeper.token, {
        items: [{ type: 'identity_change', id: await pendingNameChange(1) }],
      })
      .expect(403);
  });

  it('a plan request above payment_plan_above_limit is the board’s; at or below it, the manager’s', async () => {
    await n
      .http('patch', '/staff/governance/settings', s.manager.token, {
        items: [{ type: 'payment_plan_above_limit', threshold: '5000.00' }],
      })
      .expect(200);
    const plan = (total: string) =>
      inTx(async (tx) => {
        const batchId = await batchRow(tx, {
          tenantId: s.c.tenantId,
          unitId: s.homeA.id,
          createdById: s.c.managerId,
        });
        const invoiceId = await invoiceRow(tx, {
          tenantId: s.c.tenantId,
          unitId: s.homeA.id,
          batchId,
          createdById: s.c.managerId,
          total,
        });
        const id = newId();
        await tx.instalmentPlanRequest.create({
          data: {
            id,
            tenantId: s.c.tenantId,
            invoiceId,
            unitId: s.homeA.id,
            requestedById: s.alice.id,
            months: 3,
          },
        });
        return id;
      });
    const big = await plan('9000.00');
    const small = await plan('5000.00');
    const rows = mine(await list('/staff/inbox?type=plan_request'), [
      big,
      small,
    ]);
    expect(rows.find((r) => r.id === big)).toMatchObject({
      amount: '9000.00',
      authority: { limit: '5000.00', decider: 'board' },
    });
    expect(rows.find((r) => r.id === small)).toMatchObject({
      amount: '5000.00',
      authority: { limit: '5000.00', decider: 'manager' },
    });
  });

  describe('the overdue notice', () => {
    const told = (id: string) =>
      inTx((tx) =>
        tx.notification.findMany({
          where: { kind: 'staff_inbox.overdue', targetId: id },
          select: { accountId: true, params: true },
        }),
      );

    it('the deciders of an overdue item are told once; a fresh one, and the second run, tell nobody', async () => {
      const late = await pendingVehicle(80);
      const fresh = await pendingVehicle(1);
      await n.sweep(INBOX_OVERDUE_SWEEP, new Date());
      const first = await told(late);
      expect(first.map((t) => t.accountId)).toContain(s.c.managerId);
      expect(
        first.every(
          (t) => (t.params as { itemType: string }).itemType === 'vehicle',
        ),
      ).toBe(true);
      expect(await told(fresh)).toEqual([]);
      await n.sweep(INBOX_OVERDUE_SWEEP, new Date());
      expect((await told(late)).length).toBe(first.length);
    });

    it('two runs at once tell each decider once (3×)', async () => {
      for (let round = 0; round < 3; round++) {
        const late = await pendingVehicle(90);
        const now = new Date();
        await Promise.all([
          n.sweep(INBOX_OVERDUE_SWEEP, now),
          n.sweep(INBOX_OVERDUE_SWEEP, now),
        ]);
        const rows = await told(late);
        const per = new Map<string, number>();
        for (const r of rows)
          per.set(r.accountId, (per.get(r.accountId) ?? 0) + 1);
        expect([...per.values()].every((v) => v === 1)).toBe(true);
        expect(per.has(s.c.managerId)).toBe(true);
      }
    });
  });
});

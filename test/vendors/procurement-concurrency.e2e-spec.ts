import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0077's races: two contracts registering one new vendor by name, a
 * suspension against a contract naming the vendor, two renewals of one
 * contract, one board approval claimed by a contract and a purchase request
 * at once, and one payment paid twice.
 */
describe('Vendors, contracts and purchase requests — concurrency (ADR 0077)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof budgetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let budget: BudgetBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = budgetHelpers(h);
    s = await f.setUp(4, 3);
    budget = await f.activeBudget(
      s.accountant,
      [s.owners[0], s.owners[1]],
      [{ category: 'maintenance', amount: '500000.00' }],
    );
  }, 240_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const contract = (body: object) =>
    f.http('post', '/maintenance/contracts', m(), {
      code: `C-${uniqueSuffix()}`,
      kind: 'amc',
      startsOn: day(-30),
      endsOn: day(300),
      ...body,
    });
  const vendor = async () =>
    (
      (
        await f
          .http('post', '/staff/vendors', m(), {
            name: `Race Co. ${uniqueSuffix()}`,
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  it('two contracts naming one new vendor at once register it once', async () => {
    for (let i = 0; i < 3; i++) {
      const name = `Twin Co. ${uniqueSuffix()}`;
      const [a, b] = await Promise.all([
        contract({ vendorName: name }),
        contract({ vendorName: name.toLowerCase() }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect((a.body as { vendorId: string }).vendorId).toBe(
        (b.body as { vendorId: string }).vendorId,
      );
      const count = await f.inTx(s.c, (tx) =>
        tx.vendor.count({
          where: { name: { equals: name, mode: 'insensitive' } },
        }),
      );
      expect(count).toBe(1);
    }
  });

  it('a suspension against a contract naming the vendor: the contract is either in before it or refused', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await vendor();
      const [c, susp] = await Promise.all([
        contract({ vendorId: id }),
        f.http('post', `/staff/vendors/${id}/suspend`, m(), {
          reasonCode: 'performance',
        }),
      ]);
      expect(susp.status).toBe(200);
      expect([201, 409]).toContain(c.status);
      const row = await f.inTx(s.c, (tx) =>
        tx.vendor.findUniqueOrThrow({ where: { id } }),
      );
      if (c.status === 201) {
        const made = await f.inTx(s.c, (tx) =>
          tx.maintenanceContract.findUniqueOrThrow({
            where: { id: (c.body as { id: string }).id },
          }),
        );
        expect(made.createdAt.getTime()).toBeLessThanOrEqual(
          row.suspendedAt!.getTime(),
        );
      } else expect(c.body).toMatchObject({ code: 'VENDOR_SUSPENDED' });
    }
  });

  it('two renewals of one contract at once: one renews it, the other is told', async () => {
    for (let i = 0; i < 3; i++) {
      const c = (
        (await contract({ vendorId: await vendor() }).expect(201)).body as {
          id: string;
        }
      ).id;
      const renew = () =>
        f.http('post', `/maintenance/contracts/${c}/renew`, m(), {
          code: `R-${uniqueSuffix()}`,
          endsOn: day(700),
        });
      const results = await Promise.all([renew(), renew()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'CONTRACT_ALREADY_RENEWED',
      });
      const renewals = await f.inTx(s.c, (tx) =>
        tx.maintenanceContract.count({ where: { renewsId: c } }),
      );
      expect(renewals).toBe(1);
    }
  });

  it('one board approval claimed by a contract and a purchase request at once covers one of them', async () => {
    await f
      .http('patch', '/staff/governance/settings', m(), {
        items: [{ type: 'major_contract', threshold: '10000.00' }],
      })
      .expect(200);
    try {
      for (let i = 0; i < 3; i++) {
        const r = await f.raise(s.manager, {
          type: 'major_contract',
          cost: '40000.00',
          context: 'One approval, two claims',
        });
        await f.approve([s.owners[0], s.owners[1]], r.id);
        const pr = (
          (
            await f
              .http('post', '/staff/purchase-requests', s.accountant.token, {
                title: 'A new pump',
                estimatedAmount: '30000',
                budgetLineId: budget.lines[0].id,
              })
              .expect(201)
          ).body as { id: string }
        ).id;
        const [c, p] = await Promise.all([
          contract({
            vendorId: await vendor(),
            annualValue: '30000',
            approvalRequestId: r.id,
          }),
          f.http('post', `/staff/purchase-requests/${pr}/approve`, m(), {
            approvalRequestId: r.id,
          }),
        ]);
        const ok = [c.status === 201, p.status === 200].filter(Boolean);
        expect(ok).toHaveLength(1);
        const uses = await f.inTx(s.c, async (tx) => [
          await tx.maintenanceContract.count({
            where: { approvalRequestId: r.id },
          }),
          await tx.purchaseRequest.count({
            where: { approvalRequestId: r.id },
          }),
        ]);
        expect(uses[0] + uses[1]).toBe(1);
      }
    } finally {
      await f
        .http('patch', '/staff/governance/settings', m(), {
          items: [{ type: 'major_contract', threshold: null }],
        })
        .expect(200);
    }
  });

  it('one payment paid twice at once is paid once', async () => {
    for (let i = 0; i < 3; i++) {
      const c = (
        (await contract({ vendorId: await vendor() }).expect(201)).body as {
          id: string;
        }
      ).id;
      const [p] = (
        (
          await f
            .http('put', `/maintenance/contracts/${c}/payments`, m(), {
              payments: [{ dueOn: day(10), amount: '900' }],
            })
            .expect(200)
        ).body as { data: { id: string }[] }
      ).data;
      const pay = () =>
        f.http(
          'post',
          `/maintenance/contracts/${c}/payments/${p.id}/pay`,
          m(),
          {
            paidOn: clock().today,
          },
        );
      const results = await Promise.all([pay(), pay()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  });
});

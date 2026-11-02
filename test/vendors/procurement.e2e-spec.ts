import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  CONTRACT_SWEEP,
  PAYMENT_SWEEP,
} from '../../src/maintenance/contracts/contract-sweep';
import { VENDOR_DOCUMENT_SWEEP } from '../../src/maintenance/vendors/vendor-sweep';
import { err } from '../api/request';
import { budgetHelpers, type BudgetBody } from '../setup/budgets';
import { at, clock, day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Vendor {
  id: string;
  reference: string;
  name: string;
  status: string;
  categories: string[];
  partnerId: string | null;
  documents: { id: string; kind: string; expired: boolean }[];
  documentsExpired: boolean;
  evaluations: { count: number; averages: Record<string, number | null> };
  contracts: { total: number; active: number };
}
interface Contract {
  id: string;
  code: string;
  vendorId: string;
  vendorName: string;
  annualValue: string | null;
  renewsId: string | null;
  renewalId: string | null;
  approvalRequestId: string | null;
  assetIds: string[];
}
interface Payment {
  id: string;
  dueOn: string;
  amount: string;
  paidOn: string | null;
}
interface Purchase {
  id: string;
  reference: string;
  status: string;
  mine: boolean;
  approvalRequestId: string | null;
}

/**
 * ADR 0077: the vendor register, the compound's contracts naming a vendor
 * and signed under the board above the manager's limit, renewed once and
 * paid on a schedule, an expense naming a vendor, and light purchase
 * requests approved by the manager up to the limit.
 */
describe('Vendors, contracts and purchase requests (ADR 0077)', () => {
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

  const http = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => f.http(method, path, token, body);
  const m = () => s.manager.token;
  const line = () => budget.lines[0];
  const sweep = (name: string) =>
    h.moduleRef.get(SweepRunner).run(name, new Date());
  const notices = (accountId: string, kind: string, targetId: string) =>
    f.inTx(s.c, (tx) =>
      tx.notification.count({ where: { accountId, kind, targetId } }),
    );

  const vendor = async (over: object = {}) =>
    (
      await http('post', '/staff/vendors', m(), {
        name: `Lift Co. ${uniqueSuffix()}`,
        categories: ['maintenance'],
        phone: '+20 2 1234 5678',
        ...over,
      }).expect(201)
    ).body as Vendor;
  const createContract = (body: object) =>
    http('post', '/maintenance/contracts', m(), {
      code: `C-${uniqueSuffix()}`,
      kind: 'amc',
      startsOn: day(-30),
      endsOn: day(300),
      ...body,
    });
  const majorContract = async (cost: string) => {
    const r = await f.raise(s.manager, {
      type: 'major_contract',
      cost,
      context: 'The lifts’ yearly contract',
    });
    await f.approve([s.owners[0], s.owners[1]], r.id);
    return r.id;
  };
  const setThreshold = (threshold: string | null) =>
    http('patch', '/staff/governance/settings', m(), {
      items: [{ type: 'major_contract', threshold }],
    }).expect(200);

  describe('the register', () => {
    it('numbers a vendor V-, keeps one name whatever its case, and lists it by trade and name', async () => {
      const v = await vendor({
        name: `Nile Clean ${uniqueSuffix()}`,
        categories: ['cleaning', 'cleaning'],
      });
      expect(v.reference).toMatch(/^V-\d{4,}$/);
      expect(v.categories).toEqual(['cleaning']);
      expect(v.status).toBe('active');
      expect(
        err(
          await http('post', '/staff/vendors', m(), {
            name: v.name.toUpperCase(),
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'VENDOR_NAME_TAKEN',
        params: { vendorId: v.id },
      });
      const found = (
        await http(
          'get',
          `/staff/vendors?category=cleaning&q=nile%20clean&limit=100`,
          m(),
        ).expect(200)
      ).body as { data: { id: string }[] };
      expect(found.data.map((x) => x.id)).toContain(v.id);
      // A purchase requester reads the register; a resident never.
      await http('get', `/staff/vendors/${v.id}`, s.accountant.token).expect(
        200,
      );
      await http('get', '/staff/vendors', s.owners[2].token).expect(403);
      await http('post', '/staff/vendors', s.accountant.token, {
        name: 'X',
      }).expect(403);
    });

    it('links at most one vendor to a partner', async () => {
      const partnerId = await f.inTx(s.c, async (tx) => {
        const id = crypto.randomUUID();
        await tx.partner.create({
          data: {
            id,
            tenantId: s.c.tenantId,
            nameEn: 'Garden Partner',
            nameAr: 'شريك الحدائق',
            businessPhone: '+20222223333',
            listedAt: new Date(),
            createdById: s.manager.id,
          },
        });
        return id;
      });
      const v = await vendor({ partnerId });
      expect(v.partnerId).toBe(partnerId);
      expect(
        err(
          await http('post', '/staff/vendors', m(), {
            name: `Other ${uniqueSuffix()}`,
            partnerId,
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'VENDOR_PARTNER_TAKEN',
        params: { vendorId: v.id },
      });
      expect(
        err(
          await http('post', '/staff/vendors', m(), {
            name: `Ghost ${uniqueSuffix()}`,
            partnerId: crypto.randomUUID(),
          }).expect(400),
        ).fields,
      ).toEqual([{ field: 'partnerId', code: 'PARTNER_NOT_AVAILABLE' }]);
    });

    it('suspended with a code: no new contract or expense names it; reinstated, it does again', async () => {
      const v = await vendor();
      expect(
        err(
          await http('post', `/staff/vendors/${v.id}/suspend`, m(), {
            reasonCode: 'nope',
          }).expect(400),
        ),
      ).toMatchObject({
        fields: [
          expect.objectContaining({
            field: 'reasonCode',
            code: 'INVALID_REASON_CODE',
          }),
        ],
      });
      const suspended = (
        await http('post', `/staff/vendors/${v.id}/suspend`, m(), {
          reasonCode: 'performance',
        }).expect(200)
      ).body as Vendor;
      expect(suspended.status).toBe('suspended');
      expect(
        err(
          await http('post', `/staff/vendors/${v.id}/suspend`, m(), {
            reasonCode: 'performance',
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'VENDOR_WRONG_STATUS',
        params: { status: 'suspended' },
      });
      expect(
        err(await createContract({ vendorId: v.id }).expect(409)),
      ).toMatchObject({ code: 'VENDOR_SUSPENDED' });
      // By its name too, whatever the case.
      expect(
        err(
          await createContract({ vendorName: v.name.toLowerCase() }).expect(
            409,
          ),
        ),
      ).toMatchObject({ code: 'VENDOR_SUSPENDED' });
      expect(
        (await f.expense(s.accountant, line().id, '100.00', { vendor: v.name }))
          .status,
      ).toBe(409);
      expect(
        (
          await f.expense(s.accountant, line().id, '100.00', {
            vendorId: v.id,
            vendor: undefined,
          })
        ).status,
      ).toBe(409);
      await http('post', `/staff/vendors/${v.id}/reinstate`, m()).expect(200);
      const e = await f.expense(s.accountant, line().id, '100.00', {
        vendor: v.name.toUpperCase(),
      });
      expect(e.status).toBe(201);
      expect(e.body).toMatchObject({ vendor: v.name, vendorId: v.id });
    });

    it('files papers, removes one once, flags a lapsed one, and announces an expiry once per date', async () => {
      const v = await vendor();
      const file = await f.files.ready(
        m(),
        'vendor_document',
        'application/pdf',
      );
      const soon = (
        await http('post', `/staff/vendors/${v.id}/documents`, m(), {
          kind: 'insurance',
          fileId: file,
          number: 'POL-77/2027',
          issuedOn: day(-300),
          expiresOn: day(20),
        }).expect(201)
      ).body as { id: string; expired: boolean };
      expect(soon.expired).toBe(false);
      const lapsed = (
        await http('post', `/staff/vendors/${v.id}/documents`, m(), {
          kind: 'licence',
          fileId: await f.files.ready(m(), 'vendor_document', 'image/png'),
          expiresOn: day(-1),
        }).expect(201)
      ).body as { id: string; expired: boolean };
      expect(lapsed.expired).toBe(true);
      expect(
        err(
          await http('post', `/staff/vendors/${v.id}/documents`, m(), {
            kind: 'insurance',
            fileId: file,
          }).expect(400),
        ).fields,
      ).toEqual([{ field: 'fileId', code: 'FILE_NOT_AVAILABLE' }]);
      expect(
        (
          (await http('get', `/staff/vendors/${v.id}`, m()).expect(200))
            .body as Vendor
        ).documentsExpired,
      ).toBe(true);
      await sweep(VENDOR_DOCUMENT_SWEEP);
      await sweep(VENDOR_DOCUMENT_SWEEP);
      expect(
        await notices(s.manager.id, 'vendor_document.expiring', v.id),
      ).toBe(1);
      await http(
        'delete',
        `/staff/vendors/${v.id}/documents/${lapsed.id}`,
        m(),
      ).expect(204);
      await http(
        'delete',
        `/staff/vendors/${v.id}/documents/${lapsed.id}`,
        m(),
      ).expect(404);
      const after = (
        await http('get', `/staff/vendors/${v.id}`, m()).expect(200)
      ).body as Vendor;
      expect(after.documents.map((d) => d.id)).toEqual([soon.id]);
      expect(after.documentsExpired).toBe(false);
    });

    it('evaluates a vendor for its own contract only, and averages the last year', async () => {
      const v = await vendor();
      const c = (await createContract({ vendorId: v.id }).expect(201))
        .body as Contract;
      const other = (
        await createContract({ vendorId: (await vendor()).id }).expect(201)
      ).body as Contract;
      const scores = {
        quality: 5,
        timeliness: 4,
        cost: 3,
        communication: 5,
        safety: 5,
      };
      expect(
        err(
          await http('post', `/staff/vendors/${v.id}/evaluations`, m(), {
            ...scores,
            contractId: other.id,
          }).expect(400),
        ).fields,
      ).toEqual([{ field: 'contractId', code: 'CONTRACT_NOT_OF_VENDOR' }]);
      expect(
        err(
          await http('post', `/staff/vendors/${v.id}/evaluations`, m(), {
            ...scores,
            safety: 6,
          }).expect(400),
        ).fields,
      ).toEqual([expect.objectContaining({ field: 'safety' })]);
      await http('post', `/staff/vendors/${v.id}/evaluations`, m(), {
        ...scores,
        contractId: c.id,
      }).expect(201);
      const read = (
        await http('post', `/staff/vendors/${v.id}/evaluations`, m(), {
          quality: 4,
          timeliness: 2,
          cost: 3,
          communication: 4,
          safety: 5,
          note: 'Late twice',
        }).expect(201)
      ).body as Vendor;
      expect(read.evaluations).toEqual({
        count: 2,
        averages: {
          quality: 4.5,
          timeliness: 3,
          cost: 3,
          communication: 4.5,
          safety: 5,
          overall: 4,
        },
      });
      expect(read.contracts).toEqual({ total: 1, active: 1 });
      const list = (
        await http('get', `/staff/vendors/${v.id}/evaluations`, m()).expect(200)
      ).body as { data: { note: string | null }[] };
      expect(list.data.map((e) => e.note)).toEqual(['Late twice', null]);
    });
  });

  describe('contracts', () => {
    afterEach(() => setThreshold(null));

    it('names a vendor by its id, or finds or registers one by its name', async () => {
      const name = `Gate Guards ${uniqueSuffix()}`;
      const a = (
        await createContract({ kind: 'security', vendorName: name }).expect(201)
      ).body as Contract;
      const b = (
        await createContract({
          kind: 'security',
          vendorName: name.toUpperCase(),
        }).expect(201)
      ).body as Contract;
      expect(b.vendorId).toBe(a.vendorId);
      expect(b.vendorName).toBe(name);
      expect(err(await createContract({}).expect(400)).fields).toEqual([
        expect.objectContaining({ field: 'vendorName' }),
      ]);
      const v = (
        await http('get', `/staff/vendors/${a.vendorId}`, m()).expect(200)
      ).body as Vendor;
      expect(v.contracts.total).toBe(2);
      const listed = (
        await http(
          'get',
          `/maintenance/contracts?vendorId=${a.vendorId}&limit=100`,
          m(),
        ).expect(200)
      ).body as { data: { id: string }[] };
      expect(listed.data.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('above the manager’s limit needs the board’s approved major contract of at least the value, signing one contract', async () => {
      await setThreshold('50000.00');
      const v = await vendor();
      expect(
        err(
          await createContract({ vendorId: v.id, annualValue: '80000' }).expect(
            409,
          ),
        ),
      ).toMatchObject({
        code: 'CONTRACT_NEEDS_APPROVAL',
        params: { threshold: '50000.00' },
      });
      await createContract({ vendorId: v.id, annualValue: '50000' }).expect(
        201,
      );
      const small = await majorContract('60000.00');
      expect(
        err(
          await createContract({
            vendorId: v.id,
            annualValue: '80000',
            approvalRequestId: small,
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'CONTRACT_APPROVAL_INVALID',
        params: { reason: 'below_value' },
      });
      const pending = await f.raise(s.manager, {
        type: 'major_contract',
        cost: '90000.00',
        context: 'Pending',
      });
      expect(
        err(
          await createContract({
            vendorId: v.id,
            annualValue: '80000',
            approvalRequestId: pending.id,
          }).expect(409),
        ),
      ).toMatchObject({
        params: { reason: 'not_approved' },
      });
      const big = await majorContract('90000.00');
      const c = (
        await createContract({
          vendorId: v.id,
          annualValue: '80000',
          approvalRequestId: big,
        }).expect(201)
      ).body as Contract;
      expect(c.approvalRequestId).toBe(big);
      expect(
        err(
          await createContract({
            vendorId: v.id,
            annualValue: '70000',
            approvalRequestId: big,
          }).expect(409),
        ),
      ).toMatchObject({
        params: { reason: 'signs_another' },
      });
      // Raised past its approval: refused.
      expect(
        err(
          await http('patch', `/maintenance/contracts/${c.id}`, m(), {
            annualValue: '95000',
          }).expect(409),
        ),
      ).toMatchObject({
        params: { reason: 'below_value' },
      });
    });

    it('renews once into a new contract with the same vendor and terms, from the day after its end', async () => {
      const v = await vendor();
      const c = (
        await createContract({
          vendorId: v.id,
          endsOn: day(30),
          annualValue: '12000',
          latePenaltyPerDay: '250',
          penaltyCap: '5000',
          responseHours: 4,
          penaltyTerms: 'Late visits pay per day',
          autoRenews: true,
          renewalTermMonths: 12,
          budgetLineId: line().id,
        }).expect(201)
      ).body as Contract;
      const renewal = (
        await http('post', `/maintenance/contracts/${c.id}/renew`, m(), {
          code: `R-${uniqueSuffix()}`,
          endsOn: day(400),
        }).expect(201)
      ).body as Contract & Record<string, unknown>;
      expect(renewal).toMatchObject({
        vendorId: v.id,
        renewsId: c.id,
        annualValue: '12000.00',
        latePenaltyPerDay: '250.00',
        responseHours: 4,
        autoRenews: true,
        budgetLineId: line().id,
        startsOn: day(31),
      });
      expect(
        (
          (await http('get', `/maintenance/contracts/${c.id}`, m()).expect(200))
            .body as Contract
        ).renewalId,
      ).toBe(renewal.id);
      expect(
        err(
          await http('post', `/maintenance/contracts/${c.id}/renew`, m(), {
            code: `R-${uniqueSuffix()}`,
            endsOn: day(400),
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'CONTRACT_ALREADY_RENEWED',
        params: { renewalId: renewal.id },
      });
      // Renewing by itself needs a term; a cap needs a daily penalty.
      expect(
        err(
          await createContract({ vendorId: v.id, autoRenews: true }).expect(
            400,
          ),
        ).fields,
      ).toEqual([{ field: 'renewalTermMonths', code: 'FIELD_REQUIRED' }]);
      expect(
        err(
          await createContract({ vendorId: v.id, penaltyCap: '100' }).expect(
            400,
          ),
        ).fields,
      ).toEqual([{ field: 'latePenaltyPerDay', code: 'FIELD_REQUIRED' }]);
    });

    it('a payment schedule within its dates, replaced but for what is paid; paid once; due ones listed and announced once', async () => {
      const c = (
        await createContract({
          vendorId: (await vendor()).id,
          startsOn: day(-10),
          endsOn: day(200),
        }).expect(201)
      ).body as Contract;
      expect(
        err(
          await http('put', `/maintenance/contracts/${c.id}/payments`, m(), {
            payments: [
              { dueOn: day(5), amount: '1000' },
              { dueOn: day(5), amount: '1000' },
              { dueOn: day(400), amount: '1' },
            ],
          }).expect(400),
        ).fields,
      ).toEqual([
        { field: 'payments.1.dueOn', code: 'DUPLICATE_VALUE' },
        expect.objectContaining({
          field: 'payments.2.dueOn',
          code: 'PAYMENT_OUTSIDE_CONTRACT',
        }),
      ]);
      const set = (
        await http('put', `/maintenance/contracts/${c.id}/payments`, m(), {
          payments: [
            { dueOn: day(3), amount: '1000' },
            { dueOn: day(60), amount: '2000', note: 'Second' },
          ],
        }).expect(200)
      ).body as { data: Payment[] };
      expect(set.data.map((p) => [p.dueOn, p.amount])).toEqual([
        [day(3), '1000.00'],
        [day(60), '2000.00'],
      ]);
      const first = set.data[0];
      expect(
        err(
          await http(
            'post',
            `/maintenance/contracts/${c.id}/payments/${first.id}/pay`,
            m(),
            { paidOn: day(1) },
          ).expect(400),
        ).fields,
      ).toEqual([
        expect.objectContaining({ field: 'paidOn', code: 'DAY_OUT_OF_RANGE' }),
      ]);
      const paid = (
        await http(
          'post',
          `/maintenance/contracts/${c.id}/payments/${first.id}/pay`,
          m(),
          { paidOn: clock().today, reference: 'EX-0007' },
        ).expect(200)
      ).body as Payment;
      expect(paid.paidOn).toBe(clock().today);
      expect(
        err(
          await http(
            'post',
            `/maintenance/contracts/${c.id}/payments/${first.id}/pay`,
            m(),
            { paidOn: clock().today },
          ).expect(409),
        ),
      ).toMatchObject({ code: 'CONTRACT_PAYMENT_PAID' });
      expect(
        err(
          await http('put', `/maintenance/contracts/${c.id}/payments`, m(), {
            payments: [{ dueOn: day(3), amount: '5' }],
          }).expect(409),
        ),
      ).toMatchObject({
        code: 'CONTRACT_PAYMENT_PAID',
        params: { dueOn: day(3) },
      });
      const replaced = (
        await http('put', `/maintenance/contracts/${c.id}/payments`, m(), {
          payments: [{ dueOn: day(6), amount: '700' }],
        }).expect(200)
      ).body as { data: Payment[] };
      expect(replaced.data.map((p) => [p.dueOn, p.paidOn !== null])).toEqual([
        [day(3), true],
        [day(6), false],
      ]);
      const due = (
        await http(
          'get',
          `/maintenance/contract-payments/due?from=${clock().today}&to=${day(30)}`,
          s.accountant.token,
        ).expect(200)
      ).body as { data: { contractCode: string; dueOn: string }[] };
      expect(
        due.data.filter((d) => d.contractCode === c.code).map((d) => d.dueOn),
      ).toEqual([day(6)]);
      await sweep(PAYMENT_SWEEP);
      await sweep(PAYMENT_SWEEP);
      expect(
        await notices(s.manager.id, 'maintenance_contract.payment_due', c.id),
      ).toBe(1);
      await sweep(CONTRACT_SWEEP);
    });
  });

  describe('purchase requests', () => {
    afterEach(() => setThreshold(null));

    const ask = (by: string, over: object = {}) =>
      http('post', '/staff/purchase-requests', by, {
        title: 'Two pump seals',
        estimatedAmount: '3500',
        budgetLineId: line().id,
        neededBy: day(7),
        ...over,
      });

    it('asked for by the staff, seen by its requester and the approvers, approved within the limit, fulfilled once', async () => {
      const r = (await ask(s.accountant.token).expect(201)).body as Purchase;
      expect(r).toMatchObject({ status: 'requested', mine: true });
      expect(r.reference).toMatch(/^PR-\d{4,}$/);
      expect(
        await notices(s.manager.id, 'purchase_request.submitted', r.id),
      ).toBe(1);
      // It waits in the staff inbox (ADR 0073), not approvable in bulk.
      const inbox = (
        await http(
          'get',
          '/staff/inbox?type=purchase_request&limit=100',
          m(),
        ).expect(200)
      ).body as {
        data: {
          id: string;
          number: string;
          bulk: boolean;
          amount: string | null;
        }[];
      };
      expect(inbox.data.find((i) => i.id === r.id)).toMatchObject({
        number: r.reference,
        bulk: false,
        amount: '3500.00',
      });
      expect(
        err(await ask(s.accountant.token, { neededBy: day(-1) }).expect(400))
          .fields,
      ).toEqual([
        expect.objectContaining({
          field: 'neededBy',
          code: 'DAY_OUT_OF_RANGE',
        }),
      ]);
      await ask(s.owners[2].token).expect(403);
      await http(
        'post',
        `/staff/purchase-requests/${r.id}/approve`,
        s.accountant.token,
        {},
      ).expect(403);
      const approved = (
        await http('post', `/staff/purchase-requests/${r.id}/approve`, m(), {
          note: 'Buy locally',
        }).expect(200)
      ).body as Purchase;
      expect(approved.status).toBe('approved');
      expect(
        await notices(s.accountant.id, 'purchase_request.decided', r.id),
      ).toBe(1);
      expect(
        err(
          await http(
            'post',
            `/staff/purchase-requests/${r.id}/approve`,
            m(),
            {},
          ).expect(409),
        ),
      ).toMatchObject({
        code: 'PURCHASE_REQUEST_WRONG_STATUS',
        params: { status: 'approved' },
      });
      const done = (
        await http('post', `/staff/purchase-requests/${r.id}/fulfil`, m(), {
          reference: 'EX-0042',
        }).expect(200)
      ).body as Purchase;
      expect(done.status).toBe('fulfilled');
      await http(
        'post',
        `/staff/purchase-requests/${r.id}/cancel`,
        s.accountant.token,
        { reasonCode: 'not_needed' },
      ).expect(409);
    });

    it('turned down with a code; called off by its requester; a requester sees only theirs', async () => {
      const a = (await ask(s.accountant.token).expect(201)).body as Purchase;
      const mine = (await ask(m()).expect(201)).body as Purchase;
      expect(
        err(
          await http('post', `/staff/purchase-requests/${a.id}/reject`, m(), {
            reasonCode: 'x',
          }).expect(400),
        ),
      ).toMatchObject({
        fields: [
          expect.objectContaining({
            field: 'reasonCode',
            code: 'INVALID_REASON_CODE',
          }),
        ],
      });
      await http('post', `/staff/purchase-requests/${a.id}/reject`, m(), {
        reasonCode: 'use_stock',
      }).expect(200);
      const b = (await ask(s.accountant.token).expect(201)).body as Purchase;
      const cancelled = (
        await http(
          'post',
          `/staff/purchase-requests/${b.id}/cancel`,
          s.accountant.token,
          { reasonCode: 'duplicate' },
        ).expect(200)
      ).body as Purchase;
      expect(cancelled.status).toBe('cancelled');
      const theirs = (
        await http(
          'get',
          '/staff/purchase-requests?limit=100',
          s.accountant.token,
        ).expect(200)
      ).body as { data: Purchase[] };
      expect(theirs.data.map((p) => p.id)).not.toContain(mine.id);
      await http(
        'get',
        `/staff/purchase-requests/${mine.id}`,
        s.accountant.token,
      ).expect(404);
      const all = (
        await http('get', '/staff/purchase-requests?limit=100', m()).expect(200)
      ).body as { data: Purchase[] };
      expect(all.data.map((p) => p.id)).toEqual(
        expect.arrayContaining([a.id, b.id, mine.id]),
      );
    });

    it('above the manager’s limit: only under the board’s approved major contract of at least the amount, covering one request or contract', async () => {
      await setThreshold('10000.00');
      const r = (
        await ask(s.accountant.token, { estimatedAmount: '25000' }).expect(201)
      ).body as Purchase;
      expect(
        err(
          await http(
            'post',
            `/staff/purchase-requests/${r.id}/approve`,
            m(),
            {},
          ).expect(409),
        ),
      ).toMatchObject({
        code: 'PURCHASE_NEEDS_APPROVAL',
        params: { threshold: '10000.00' },
      });
      const small = await majorContract('20000.00');
      expect(
        err(
          await http('post', `/staff/purchase-requests/${r.id}/approve`, m(), {
            approvalRequestId: small,
          }).expect(409),
        ),
      ).toMatchObject({
        params: { reason: 'below_amount' },
      });
      const big = await majorContract('30000.00');
      const ok = (
        await http('post', `/staff/purchase-requests/${r.id}/approve`, m(), {
          approvalRequestId: big,
        }).expect(200)
      ).body as Purchase;
      expect(ok.approvalRequestId).toBe(big);
      const r2 = (
        await ask(s.accountant.token, { estimatedAmount: '15000' }).expect(201)
      ).body as Purchase;
      expect(
        err(
          await http('post', `/staff/purchase-requests/${r2.id}/approve`, m(), {
            approvalRequestId: big,
          }).expect(409),
        ),
      ).toMatchObject({
        params: { reason: 'covers_another' },
      });
      // Nor may a contract sign under it now.
      expect(
        err(
          await createContract({
            vendorId: (await vendor()).id,
            annualValue: '12000',
            approvalRequestId: big,
          }).expect(409),
        ),
      ).toMatchObject({
        params: { reason: 'signs_another' },
      });
    });

    it('a suspended vendor is refused at the ask and at the approval', async () => {
      const v = await vendor();
      const r = (await ask(s.accountant.token, { vendorId: v.id }).expect(201))
        .body as Purchase;
      await http('post', `/staff/vendors/${v.id}/suspend`, m(), {
        reasonCode: 'safety',
      }).expect(200);
      expect(
        err(await ask(s.accountant.token, { vendorId: v.id }).expect(409)),
      ).toMatchObject({ code: 'VENDOR_SUSPENDED' });
      expect(
        err(
          await http(
            'post',
            `/staff/purchase-requests/${r.id}/approve`,
            m(),
            {},
          ).expect(409),
        ),
      ).toMatchObject({ code: 'VENDOR_SUSPENDED' });
    });

    it('nobody approves their own request: the manager’s waits for another approver, or the board’s approval decides it', async () => {
      const own = (await ask(m()).expect(201)).body as Purchase;
      expect(
        err(
          await http(
            'post',
            `/staff/purchase-requests/${own.id}/approve`,
            m(),
            {},
          ).expect(409),
        ),
      ).toMatchObject({ code: 'PURCHASE_SELF_APPROVAL' });
      expect(
        (
          (
            await http('get', `/staff/purchase-requests/${own.id}`, m()).expect(
              200,
            )
          ).body as Purchase
        ).status,
      ).toBe('requested');
      // Under the board's approval the board has decided it.
      const board = await majorContract('5000.00');
      const ok = (
        await http('post', `/staff/purchase-requests/${own.id}/approve`, m(), {
          approvalRequestId: board,
        }).expect(200)
      ).body as Purchase;
      expect(ok).toMatchObject({
        status: 'approved',
        approvalRequestId: board,
      });
    });

    // Needs M2-3's deputies (ADR 0073), merged before this phase verifies.
    it('a live deputy approves the manager’s own request', async () => {
      const own = (await ask(m()).expect(201)).body as Purchase;
      const endsAt = at(day(3), 12);
      const deputyship = (
        await http('post', '/staff/deputies', m(), {
          deputyAccountId: s.accountant.id,
          permissions: ['purchases.approve'],
          endsAt: endsAt.toISOString(),
        }).expect(201)
      ).body as { id: string };
      try {
        const ok = (
          await http(
            'post',
            `/staff/purchase-requests/${own.id}/approve`,
            s.accountant.token,
            {},
          ).expect(200)
        ).body as Purchase;
        expect(ok.status).toBe('approved');
        expect(
          await notices(s.manager.id, 'purchase_request.decided', own.id),
        ).toBe(1);
      } finally {
        await http('post', `/staff/deputies/${deputyship.id}/end`, m()).expect(
          200,
        );
      }
    });
  });
});

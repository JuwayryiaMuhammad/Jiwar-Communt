import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import { day } from '../setup/facilities';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import {
  financeHelpers,
  gatewayBody,
  type FinanceSetUp,
} from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { FakePaymob } from '../setup/paymob-fake';
import { waitForOtp } from '../setup/mailpit';

/**
 * One scenario per finance catalog entry (ADR 0014, 0046): actor, target
 * and metadata — ids, codes and amounts; never a credential (not even its
 * last four characters), a line's words or a plan's name.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — finance', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  let read: ReturnType<typeof auditReaders>;

  const paymob = new FakePaymob();

  beforeAll(async () => {
    h = await createHttpHarness({ paymob });
    f = financeHelpers(h);
    s = await f.setUp('Finance Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string | null) {
    const found = await read.tenant(s.c.tenantId, {
      action,
      ...(targetId ? { targetId } : {}),
    });
    covered.add(action);
    expect(found).toHaveLength(1);
    return found[0];
  }

  describe('the platform step-up', () => {
    it('requested, failed, verified: the session id only', async () => {
      const admin = await f.platformAdmin();
      const { email } = await h.moduleRef
        .get(GlobalDbService)
        .platformAdmin.findUniqueOrThrow({ where: { id: admin.id } });
      const since = new Date();
      await h
        .http()
        .post(`${API}/platform/step-up`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({})
        .expect(202);
      const code = await waitForOtp(email, since);
      const verify = (c: string) =>
        h
          .http()
          .post(`${API}/platform/step-up/verify`)
          .set('Authorization', `Bearer ${admin.token}`)
          .send({ code: c });
      await verify(code === '000000' ? '111111' : '000000').expect(403);
      await verify(code).expect(200);
      for (const event of [
        'platform.step_up_requested',
        'platform.step_up_failed',
        'platform.step_up_verified',
      ] as const) {
        const rows = await read.security({ event, platformAdminId: admin.id });
        covered.add(event);
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0].metadata as object)).toEqual(['sessionId']);
      }
    });
  });

  describe('the gateway', () => {
    let body: ReturnType<typeof gatewayBody>;

    it('finance_gateway.set: the fields that changed and the mode', async () => {
      body = await f.configureGateway(s.manager, {}, false);
      const row = await single('finance_gateway.set', s.c.tenantId);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.manager.id,
        targetType: 'tenant',
        targetId: s.c.tenantId,
        changes: null,
        metadata: {
          fieldsChanged: [
            'secretKey',
            'publicKey',
            'hmacSecret',
            'cardIntegrationId',
            'walletIntegrationId',
          ],
          mode: 'sandbox',
        },
      });
      for (const v of [body.secretKey, body.publicKey, body.hmacSecret])
        expect(JSON.stringify(row)).not.toContain(v.slice(-4));
    });

    it('finance_gateway.toggled: on or off', async () => {
      await f.stepUp(s.manager.token);
      await f
        .http('patch', '/staff/finance/gateway', s.manager.token, {
          onlineEnabled: true,
        })
        .expect(200);
      const row = await single('finance_gateway.toggled', s.c.tenantId);
      expect(row.metadata).toEqual({ onlineEnabled: true });
    });

    it('tenant.payment_gateway_set and _toggled: in the platform log', async () => {
      const admin = await f.platformAdmin(true);
      const path = `/platform/tenants/${s.c.tenantId}/payment-gateway`;
      await f
        .http('put', path, admin.token, {
          ...body,
          hmacSecret: `${body.hmacSecret}X`,
        })
        .expect(200);
      await f.platformStepUp(admin.token);
      await f
        .http('patch', path, admin.token, { platformDisabled: true })
        .expect(200);
      const rows = (
        await read.platform({ targetTenantId: s.c.tenantId })
      ).filter((r) => r.action.startsWith('tenant.payment_gateway_'));
      covered.add('tenant.payment_gateway_set');
      covered.add('tenant.payment_gateway_toggled');
      expect(
        rows.map((r) => [r.action, r.actorType, r.actorId, r.metadata]),
      ).toEqual([
        [
          'tenant.payment_gateway_set',
          'platform_admin',
          admin.id,
          { fieldsChanged: ['hmacSecret'], mode: 'sandbox' },
        ],
        [
          'tenant.payment_gateway_toggled',
          'platform_admin',
          admin.id,
          { platformDisabled: true },
        ],
      ]);
    });
  });

  describe('invoices', () => {
    let invoiceId: string;

    it('invoice_batch.issued: the target, the count, the amount and the numbers; never a line’s words', async () => {
      const res = await f
        .http('post', '/staff/invoices', s.accountant.token, {
          target: 'unit',
          unitId: s.home.id,
          kind: 'maintenance',
          dueOn: day(7),
          lines: [
            {
              descriptionEn: `${MARKER} pump`,
              descriptionAr: `${MARKER} مضخة`,
              amount: '450',
            },
          ],
        })
        .expect(201);
      const batch = res.body as { id: string; firstNumber: string };
      const row = await single('invoice_batch.issued', batch.id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.accountant.id,
        targetType: 'invoice_batch',
        changes: null,
        metadata: {
          target: 'unit',
          unitId: s.home.id,
          unitCount: 1,
          kind: 'maintenance',
          total: '450.00',
          issuedOn: day(0),
          dueOn: day(7),
          firstNumber: batch.firstNumber,
          lastNumber: batch.firstNumber,
        },
      });
      expect(JSON.stringify(row)).not.toContain(MARKER);
      invoiceId = (
        (
          await f
            .http(
              'get',
              `/staff/invoices?batchId=${batch.id}`,
              s.accountant.token,
            )
            .expect(200)
        ).body as { data: { id: string }[] }
      ).data[0].id;
    });

    it('a building’s issue names the target, never the building', async () => {
      await f.unit(s.c, `${MARKER}-B`);
      const res = await f
        .http('post', '/staff/invoices', s.manager.token, {
          target: 'building',
          building: `${MARKER}-B`,
          kind: 'other',
          dueOn: day(7),
          lines: [{ descriptionEn: 'x', descriptionAr: 'س', amount: '1' }],
        })
        .expect(201);
      const found = await read.tenant(s.c.tenantId, {
        action: 'invoice_batch.issued',
        targetId: (res.body as { id: string }).id,
      });
      expect(found).toHaveLength(1);
      expect(found[0].metadata).toMatchObject({
        target: 'building',
        unitCount: 1,
      });
      expect(JSON.stringify(found[0])).not.toContain(MARKER);
    });

    it('credit_note.created: the invoice, the unit, the number, the amount and the reason', async () => {
      const res = await f
        .http(
          'post',
          `/staff/invoices/${invoiceId}/credit-notes`,
          s.manager.token,
          {
            amount: '50',
            reasonCode: 'goodwill',
          },
        )
        .expect(201);
      const note = res.body as { id: string; number: string };
      const row = await single('credit_note.created', note.id);
      expect(row).toMatchObject({
        actorId: s.manager.id,
        targetType: 'credit_note',
        metadata: {
          invoiceId,
          unitId: s.home.id,
          number: note.number,
          amount: '50.00',
          reasonCode: 'goodwill',
        },
      });
    });
  });

  describe('billing plans', () => {
    let planId: string;

    it('billing_plan.created: terms by value, names as changed only', async () => {
      const res = await f
        .http('post', '/staff/billing-plans', s.manager.token, {
          nameEn: `${MARKER} fee`,
          nameAr: `${MARKER} رسم`,
          kind: 'service_charge',
          frequency: 'quarterly',
          amount: '3000',
          startsOn: `${day(0).slice(0, 8)}01`,
          issueDaysBefore: 3,
          dueDaysAfterIssue: 14,
        })
        .expect(201);
      planId = (res.body as { id: string }).id;
      const row = await single('billing_plan.created', planId);
      expect(row).toMatchObject({
        actorId: s.manager.id,
        targetType: 'billing_plan',
        changes: {
          nameEn: { changed: true },
          nameAr: { changed: true },
          kind: { from: null, to: 'service_charge' },
          frequency: { from: null, to: 'quarterly' },
          amount: { from: null, to: '3000.00' },
          issueDaysBefore: { from: null, to: 3 },
          dueDaysAfterIssue: { from: null, to: 14 },
          active: { from: null, to: true },
        },
      });
      expect(JSON.stringify(row)).not.toContain(MARKER);
    });

    it('billing_plan.updated: what changed', async () => {
      await f
        .http('patch', `/staff/billing-plans/${planId}`, s.accountant.token, {
          nameEn: `${MARKER} new`,
          amount: '3200',
        })
        .expect(200);
      const row = await single('billing_plan.updated', planId);
      expect(row.changes).toEqual({
        nameEn: { changed: true },
        amount: { from: '3000.00', to: '3200.00' },
      });
      expect(JSON.stringify(row)).not.toContain(MARKER);
    });

    it('billing_plan.override_set and _removed: the unit and its terms', async () => {
      const path = `/staff/billing-plans/${planId}/overrides/${s.home.id}`;
      await f
        .http('put', path, s.manager.token, { amount: '1000' })
        .expect(200);
      await f
        .http('put', path, s.manager.token, { excluded: true })
        .expect(200);
      const set = await read.tenant(s.c.tenantId, {
        action: 'billing_plan.override_set',
        targetId: planId,
      });
      covered.add('billing_plan.override_set');
      expect(set.map((r) => r.metadata)).toEqual([
        { unitId: s.home.id, amount: '1000.00', excluded: false },
        {
          unitId: s.home.id,
          amount: null,
          excluded: true,
          previousAmount: '1000.00',
          previousExcluded: false,
        },
      ]);
      await f.http('delete', path, s.manager.token).expect(204);
      const removed = await single('billing_plan.override_removed', planId);
      expect(removed.metadata).toEqual({ unitId: s.home.id });
    });
  });

  describe('payments', () => {
    it('payment.recorded and payment.reversed: amounts, codes and ids; never the reference', async () => {
      const { invoiceId } = await f.issue(s.manager, s.home.id);
      const res = await f
        .http(
          'post',
          `/staff/units/${s.home.id}/payments`,
          s.accountant.token,
          {
            amount: '300',
            method: 'cheque',
            reference: 'CHQ-AUDIT-991',
            paidOn: day(0),
            invoiceIds: [invoiceId],
          },
        )
        .expect(201);
      const payment = res.body as { id: string; receiptNumber: string };
      const recorded = await single('payment.recorded', payment.id);
      expect(recorded).toMatchObject({
        actorId: s.accountant.id,
        targetType: 'payment',
        metadata: {
          unitId: s.home.id,
          channel: 'office',
          method: 'cheque',
          amount: '300.00',
          paidOn: day(0),
          receiptNumber: payment.receiptNumber,
          invoiceIds: [invoiceId],
        },
      });
      expect(JSON.stringify(recorded)).not.toContain('CHQ-AUDIT-991');
      const reversal = await f
        .http(
          'post',
          `/staff/payments/${payment.id}/reverse`,
          s.manager.token,
          {
            reasonCode: 'bounced_cheque',
          },
        )
        .expect(201);
      expect((reversal.body as { id: string }).id).toBe(payment.id);
      const rows = await read.tenant(s.c.tenantId, {
        action: 'payment.reversed',
      });
      covered.add('payment.reversed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: s.manager.id,
        metadata: {
          paymentId: payment.id,
          unitId: s.home.id,
          amount: '300.00',
          reasonCode: 'bounced_cheque',
        },
      });
    });
  });

  describe('online', () => {
    it('payment_session.opened: the unit, the amount and the invoices; never Paymob’s secret', async () => {
      const c = await f.setUp('Finance Audit Online');
      await f.configureGateway(c.manager);
      const { invoiceId } = await f.issue(c.manager, c.home.id);
      const res = await f
        .http('post', `/units/${c.home.id}/payment-sessions`, c.owner.token, {})
        .expect(201);
      const session = res.body as { id: string; checkoutUrl: string };
      const rows = await read.tenant(c.c.tenantId, {
        action: 'payment_session.opened',
        targetId: session.id,
      });
      covered.add('payment_session.opened');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'account',
        actorId: c.owner.id,
        targetType: 'payment_session',
        metadata: {
          unitId: c.home.id,
          amount: '1000.00',
          invoiceIds: [invoiceId],
        },
      });
      const secret = new URL(session.checkoutUrl).searchParams.get(
        'clientSecret',
      )!;
      expect(JSON.stringify(rows[0])).not.toContain(secret);
    });
  });

  describe('the webhook', () => {
    it('refused, order mismatch, amount mismatch, contradicted, charged twice: the compound and the session only', async () => {
      const c = await f.setUp('Finance Audit Webhook');
      const creds = await f.configureGateway(c.manager);
      const rented = await f.unit(c.c, 'A');
      const tenant = await f.tenant(c.c, rented.id);
      await f.issue(c.manager, c.home.id);
      await f.issue(c.manager, rented.id);
      const open = async (unitId: string, token: string) => {
        const res = await f
          .http('post', `/units/${unitId}/payment-sessions`, token, {})
          .expect(201);
        const id = (res.body as { id: string }).id;
        return { id, intention: paymob.byReference(`jw-${id}`) };
      };
      const send = (cb: { hmac: string; body: object }) =>
        h
          .http()
          .post(`${API}/public/payments/paymob/${c.c.tenantId}?hmac=${cb.hmac}`)
          .send(cb.body);
      const a = await open(c.home.id, c.owner.token);
      const b = await open(rented.id, tenant.token);
      a.intention.paid = true;
      const good = paymob.callback(a.intention, creds.hmacSecret);
      await send({ hmac: 'f'.repeat(128), body: good.body }).expect(401);
      await send(
        paymob.callback(a.intention, creds.hmacSecret, {}, (obj) => {
          (obj.order as Record<string, unknown>).merchant_order_id =
            `jw-${b.id}`;
        }),
      ).expect(200);
      await send(
        paymob.callback(a.intention, creds.hmacSecret, {
          amount_cents: a.intention.amountCents + 1,
        }),
      ).expect(200);
      b.intention.paid = true;
      const real = b.intention.amountCents;
      b.intention.amountCents = real + 100;
      await send(
        paymob.callback(b.intention, creds.hmacSecret, { amount_cents: real }),
      ).expect(200);
      await send(good).expect(200);
      await send(paymob.callback(a.intention, creds.hmacSecret)).expect(200);
      for (const [event, session] of [
        ['payment.order_mismatch', b.id],
        ['payment.amount_mismatch', a.id],
        ['payment.verification_contradicted', b.id],
        ['payment.duplicate_charge', a.id],
      ] as const) {
        const rows = (await read.security({ event })).filter(
          (r) => r.tenantId === c.c.tenantId,
        );
        covered.add(event);
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toEqual({ sessionId: session });
      }
      const rejected = (
        await read.security({ event: 'payment.webhook_rejected' })
      ).filter((r) => r.tenantId === c.c.tenantId);
      covered.add('payment.webhook_rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].metadata).toEqual({ reason: 'hmac' });
    });
  });

  describe('catalog completeness', () => {
    it('every finance entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FINANCE_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
          ...MANAGEMENT_COVERAGE,
          ...ENGAGEMENT_COVERAGE,
          ...NEIGHBOURS_COVERAGE,
          ...FACILITIES_COVERAGE,
          ...VEHICLES_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...FINANCE_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) =>
            /^(finance_gateway|invoice|invoice_batch|credit_note|billing_plan|payment|payment_session)\.|^tenant\.payment_gateway_|^platform\.step_up_/.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...FINANCE_COVERAGE].sort());
    });
  });
});

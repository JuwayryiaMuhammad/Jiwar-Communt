import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
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
import { waitForOtp } from '../setup/mailpit';

/**
 * One scenario per finance catalog entry (ADR 0014, 0046): actor, target
 * and metadata — ids, codes and amounts; never a credential (not even its
 * last four characters), a line's words or a plan's name.
 */
const covered = new Set<string>();

describe('Audit coverage — finance', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
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

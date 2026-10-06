import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
} from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { sessionOf } from '../api/world';
import { LoginAlerts } from '../../src/core/auth/login-alerts';

/**
 * One scenario per ADR 0036 catalog entry: actor, target, changes and
 * metadata — codes, times and ids, never a name, a phone or content.
 */
const covered = new Set<string>();

describe('Audit coverage — preferences, consents, export, deletion', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  async function resident(c: Compound) {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    return { ...p, unitId: unit.id, token };
  }

  it('notification_preferences.changed — by the account', async () => {
    const c = await x.compound('Audit R1');
    const p = await resident(c);
    await h
      .http()
      .patch(`${API}/me/notification-preferences`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({
        categories: [{ category: 'maintenance', push: false }],
        quietHours: { start: '23:00', end: '06:30' },
      })
      .expect(200);
    const row = await single(c, 'notification_preferences.changed', p.id);
    expect(row).toMatchObject({
      actorType: 'account',
      actorId: p.id,
      targetType: 'account',
      metadata: { assisted: false },
    });
    expect(row.changes).toEqual({
      'maintenance.push': { from: true, to: false },
      quietHours: { from: null, to: '23:00-06:30' },
    });
  });

  it('consent.granted and consent.revoked — by the account, code and version only', async () => {
    const c = await x.compound('Audit R1');
    const p = await resident(c);
    for (const path of ['grant', 'revoke'])
      await h
        .http()
        .post(`${API}/me/consents/${path}`)
        .set('Authorization', `Bearer ${p.token}`)
        .send(
          path === 'grant'
            ? { code: 'ticket_phone_share', version: 1 }
            : { code: 'ticket_phone_share' },
        )
        .expect(200);
    for (const action of ['consent.granted', 'consent.revoked']) {
      const row = await single(c, action, p.id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: p.id,
        targetType: 'account',
        changes: null,
      });
      expect(row.metadata).toEqual({
        code: 'ticket_phone_share',
        version: 1,
        assisted: false,
      });
    }
  });

  it('step_up.requested, step_up.failed and step_up.verified — security events of the session', async () => {
    const c = await x.compound('Audit R1');
    const p = await resident(c);
    const since = new Date();
    const post = (path: string, body: object = {}) =>
      h
        .http()
        .post(`${API}/me/step-up${path}`)
        .set('Authorization', `Bearer ${p.token}`)
        .send(body);
    await post('').expect(202);
    const code = await waitForOtp(p.email, since);
    await post('/verify', {
      code: code === '000000' ? '111111' : '000000',
    }).expect(403);
    await post('/verify', { code }).expect(200);
    for (const event of [
      'step_up.requested',
      'step_up.failed',
      'step_up.verified',
    ]) {
      const rows = await read.security({ event, accountId: p.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: c.tenantId,
        identifierHash: null,
        metadata: { sessionId: sessionOf(p.token) },
      });
      covered.add(event);
    }
  });

  it('login.new_device and account.not_me — security events, the device and how', async () => {
    const c = await x.compound('Audit R1');
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const p = await x.resident(c, [unit.id], 'tenant');
    const alerts = h.moduleRef.get(LoginAlerts);
    const who = { accountId: p.id, tenantId: c.tenantId };
    await alerts.recordLogin(who, { userAgent: 'Audit/1.0 (Linux)' });
    await alerts.recordLogin(who, {
      userAgent: 'Jiwar/1.0 (iPhone)',
      installId: '0192a5f0-1c2b-7d3e-8f40-0000000000aa',
    });
    const [alert] = await read.security({
      event: 'login.new_device',
      accountId: p.id,
    });
    expect(alert).toMatchObject({
      tenantId: c.tenantId,
      ip: null,
      metadata: { deviceType: 'ios' },
    });
    covered.add('login.new_device');
    const deviceId = (alert.metadata as { deviceId: string }).deviceId;
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    await h
      .http()
      .post(`${API}/me/devices/${deviceId}/not-me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const rows = await read.security({
      event: 'account.not_me',
      accountId: p.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({
      via: 'app',
      deviceId,
      sessionsRevoked: 1,
    });
    covered.add('account.not_me');
  });

  describe('catalog completeness', () => {
    it('every ADR 0036 entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R1_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...R1_COVERAGE].sort());
    });
  });
});

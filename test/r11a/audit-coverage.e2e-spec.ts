import { IdentityChangesService } from '../../src/core/accounts/identity-changes.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { R11A_COVERAGE } from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { stepUp } from '../setup/exports';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { loginViaOtp } from '../setup/login';

/**
 * One scenario per R11a entry (ADR 0014, 0062): actor, target, changes and
 * metadata — ids, codes and fields; a name, a phone or an email never.
 */
const covered = new Set<string>();

describe('Audit coverage — R11a', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('R11a Audit Court');
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  /** Exactly one entry for (action, target), free of the planted values. */
  async function single(action: string, targetId: string, planted: string[]) {
    const found = await read.tenant(c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    for (const value of planted)
      expect(leakText(found[0])).not.toContain(value);
    return found[0];
  }

  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const { accessToken } = await loginViaOtp(h, p.email, p.id);
    return { ...p, token: accessToken };
  }

  const post = (path: string, token: string, body: object = {}) =>
    h
      .http()
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  describe('account self-service', () => {
    it('an email change asked; name and phone changes asked, withdrawn, decided', async () => {
      const me = await someone();
      const newEmail = uniqueEmail('audited');
      await stepUp(h, me.token, me.email);
      await post('/me/contact/email', me.token, { email: newEmail }).expect(
        202,
      );
      expect(
        await single('account.contact_change_requested', me.id, [newEmail]),
      ).toMatchObject({
        actorId: me.id,
        targetType: 'account',
        metadata: { field: 'email' },
      });

      const changes = h.moduleRef.get(IdentityChangesService);
      const asMe = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: me.id, type: 'resident' }, fn);
      const name = 'Audited Newname';
      await stepUp(h, me.token, me.email);
      const asked = (
        await post('/me/identity-changes', me.token, {
          field: 'name',
          value: name,
        }).expect(201)
      ).body as { id: string };
      expect(
        await single('account.identity_change_requested', me.id, [name]),
      ).toMatchObject({
        actorId: me.id,
        metadata: { requestId: asked.id, field: 'name' },
      });
      await asMe(() => changes.cancel(asked.id));
      expect(
        await single('account.identity_change_cancelled', me.id, [name]),
      ).toMatchObject({ metadata: { requestId: asked.id, field: 'name' } });

      await stepUp(h, me.token, me.email);
      const again = (
        await post('/me/identity-changes', me.token, {
          field: 'name',
          value: name,
        }).expect(201)
      ).body as { id: string };
      await x.asManager(c, () => changes.approve(again.id));
      expect(
        await single('account.identity_change_approved', me.id, [name]),
      ).toMatchObject({
        actorId: c.managerId,
        metadata: { requestId: again.id, field: 'name' },
      });
      expect(
        await single('account.name_changed', me.id, [name, me.fullName]),
      ).toMatchObject({
        actorId: c.managerId,
        changes: { fullName: { changed: true } },
        metadata: { requestId: again.id },
      });

      const phone = uniquePhone();
      await stepUp(h, me.token, me.email);
      const byPhone = (
        await post('/me/identity-changes', me.token, {
          field: 'phone',
          value: phone,
        }).expect(201)
      ).body as { id: string };
      await x.asManager(c, () =>
        changes.reject(byPhone.id, { reasonCode: 'not_verified' }),
      );
      expect(
        await single('account.identity_change_rejected', me.id, [phone]),
      ).toMatchObject({
        actorId: c.managerId,
        metadata: {
          requestId: byPhone.id,
          field: 'phone',
          reasonCode: 'not_verified',
        },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every R11a entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11A_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11A_COVERAGE].sort());
    });
  });
});

import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { R11A2_COVERAGE } from '../setup/audit-coverage-split';
import { PROXY_EXPIRY_SWEEP } from '../../src/community/proxies/proxies.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { day, daysLater } from '../setup/compound-clock';
import { nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { fileHelpers } from '../setup/files';
import { leakText } from '../setup/leak-text';
import { permitHelpers, type Who } from '../setup/permits';

/**
 * One scenario per R11a-2 entry (ADR 0014, 0063): actor, target and
 * metadata — ids, codes and fields; a name, a phone or an email never.
 */
const covered = new Set<string>();

describe('Audit coverage — R11a-2', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who,
    body?: object,
  ) =>
    h
      .http()
      [method](`${API}${path}`)
      .set('Authorization', `Bearer ${who.token}`)
      .send(body);

  /** Every entry for (action, target), free of the planted values. */
  async function entries(
    tenantId: string,
    action: string,
    targetId: string,
    planted: string[] = [],
  ) {
    const found = await read.tenant(tenantId, { action, targetId });
    covered.add(action);
    for (const e of found)
      for (const value of planted) expect(leakText(e)).not.toContain(value);
    return found;
  }

  describe('moves (ADR 0063)', () => {
    it('planned by the occupancy and by a notice, a step ticked, done at the handover, cancelled', async () => {
      const s = await p.setUp('R11a-2 Moves Audit');
      const moves = (
        await http('get', `/units/${s.home.id}/moves`, s.alice).expect(200)
      ).body as { id: string; direction: string; occupancyId: string }[];
      const moveIn = moves.find((m) => m.direction === 'in')!;
      expect(
        await entries(s.c.tenantId, 'unit_move.planned', moveIn.id),
      ).toEqual([
        expect.objectContaining({
          metadata: {
            unitId: s.home.id,
            occupancyId: moveIn.occupancyId,
            direction: 'in',
            side: 'system',
          },
        }),
      ]);

      await http('post', `/staff/moves/${moveIn.id}/steps`, s.manager, {
        step: 'meters_read',
      }).expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_move.step_done', moveIn.id),
      ).toEqual([
        expect.objectContaining({
          actorId: s.manager.id,
          metadata: {
            unitId: s.home.id,
            step: 'meters_read',
            side: 'management',
          },
        }),
      ]);

      const out = (
        await http('post', `/units/${s.home.id}/moves/move-out`, s.alice, {
          plannedOn: day(5),
        }).expect(201)
      ).body as { id: string; occupancyId: string };
      expect(await entries(s.c.tenantId, 'unit_move.planned', out.id)).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: expect.objectContaining({
            direction: 'out',
            side: 'resident',
          }) as unknown,
        }),
      ]);

      // The occupancy ends: its move-in is cancelled by the system.
      await http('post', `/occupancies/${out.occupancyId}/end`, s.manager, {
        reasonCode: 'moved_out',
        reason: 'Moved away',
      }).expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_move.cancelled', moveIn.id),
      ).toEqual([
        expect.objectContaining({
          metadata: {
            unitId: s.home.id,
            direction: 'in',
            reasonCode: 'occupancy_ended',
            side: 'system',
          },
        }),
      ]);
      await http(
        'post',
        `/occupancies/${out.occupancyId}/handover`,
        s.manager,
        {
          reasonCode: 'dues_disputed',
        },
      ).expect(200);
      expect(await entries(s.c.tenantId, 'unit_move.done', out.id)).toEqual([
        expect.objectContaining({
          actorId: s.manager.id,
          metadata: {
            unitId: s.home.id,
            direction: 'out',
            reasonCode: 'dues_disputed',
          },
        }),
      ]);
    });
  });

  describe('proxies (ADR 0063)', () => {
    it("invited, accepted by the system for the person, revoked; another ended by its invite's expiry", async () => {
      const s = await p.setUp('R11a-2 Proxies Audit');
      const email = uniqueEmail('proxy-audit');
      const planted = [email, 'Audit Proxy Name'];
      const body = {
        fullName: 'Audit Proxy Name',
        email,
        phone: uniquePhone(),
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        scopes: ['tickets'],
        endsOn: day(30),
      };
      const created = (
        await http('post', `/units/${s.home.id}/proxies`, s.alice, body).expect(
          201,
        )
      ).body as { proxy: { id: string }; token: string };
      const id = created.proxy.id;
      expect(
        await entries(s.c.tenantId, 'unit_proxy.invited', id, planted),
      ).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: expect.objectContaining({
            unitId: s.home.id,
            scopes: ['tickets'],
          }) as unknown,
        }),
      ]);

      const since = new Date();
      await h
        .http()
        .post(`${API}/proxy-invites/accept/start`)
        .send({ token: created.token })
        .expect(202);
      const code = await waitForOtp(email, since);
      await h
        .http()
        .post(`${API}/proxy-invites/accept/complete`)
        .send({ token: created.token, code })
        .expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_proxy.accepted', id, planted),
      ).toEqual([
        expect.objectContaining({
          actorType: 'system',
          metadata: expect.objectContaining({ unitId: s.home.id }) as unknown,
        }),
      ]);

      await http(
        'post',
        `/units/${s.home.id}/proxies/${id}/revoke`,
        s.alice,
      ).expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_proxy.revoked', id, planted),
      ).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: { unitId: s.home.id, wasActive: true },
        }),
      ]);

      const unanswered = (
        await http('post', `/units/${s.home.id}/proxies`, s.alice, {
          ...body,
          email: uniqueEmail('proxy-audit-2'),
        }).expect(201)
      ).body as { proxy: { id: string } };
      await h.moduleRef.get(SweepRunner).run(PROXY_EXPIRY_SWEEP, daysLater(8));
      expect(
        await entries(s.c.tenantId, 'unit_proxy.ended', unanswered.proxy.id),
      ).toEqual([
        expect.objectContaining({
          metadata: {
            unitId: s.home.id,
            wasActive: false,
            reasonCode: 'invite_expired',
          },
        }),
      ]);
    });
  });

  describe('inspection requests (ADR 0063)', () => {
    it('requested by the owner of a closed unit, cancelled with a code', async () => {
      const s = await p.setUp('R11a-2 Inspections Audit');
      await http('post', `/units/${s.home.id}/closed-mode`, s.alice, {
        closed: true,
      }).expect(204);
      const asked = (
        await http('post', `/units/${s.home.id}/inspection-requests`, s.alice, {
          preferredOn: day(3),
        }).expect(201)
      ).body as { id: string };
      expect(
        await entries(s.c.tenantId, 'unit_inspection.requested', asked.id),
      ).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: { unitId: s.home.id, side: 'owner' },
        }),
      ]);
      await http(
        'post',
        `/units/${s.home.id}/inspection-requests/${asked.id}/cancel`,
        s.alice,
        { reasonCode: 'unit_reopened' },
      ).expect(200);
      expect(
        await entries(s.c.tenantId, 'unit_inspection.cancelled', asked.id),
      ).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: { unitId: s.home.id, reasonCode: 'unit_reopened' },
        }),
      ]);
    });
  });

  describe('works completion (ADR 0063)', () => {
    it('asked by the requester, failed with findings, asked again and passed', async () => {
      const s = await p.setUp('R11a-2 Works Audit');
      const permit = await p.works(s.alice, s.home.id);
      await p.approve(s.manager, permit.id);
      const ask = async () =>
        (
          (
            await http(
              'post',
              `/permits/${permit.id}/completion-inspection`,
              s.alice,
            ).expect(201)
          ).body as { id: string }
        ).id;
      const decide = async (id: string, body: object) =>
        http('post', `/staff/permit-inspections/${id}/decide`, s.manager, {
          photoFileIds: [
            await fileHelpers(h).ready(
              s.manager.token,
              'works_inspection_photo',
            ),
          ],
          ...body,
        }).expect(200);

      const first = await ask();
      expect(
        await entries(s.c.tenantId, 'permit_inspection.requested', first),
      ).toEqual([
        expect.objectContaining({
          actorId: s.alice.id,
          metadata: { permitId: permit.id, unitId: s.home.id, cycle: 1 },
        }),
      ]);
      await decide(first, { outcome: 'failed', findings: ['debris_left'] });
      expect(
        await entries(s.c.tenantId, 'permit_inspection.failed', first),
      ).toEqual([
        expect.objectContaining({
          actorId: s.manager.id,
          metadata: {
            permitId: permit.id,
            cycle: 1,
            photos: 1,
            findings: ['debris_left'],
          },
        }),
      ]);
      const second = await ask();
      await decide(second, { outcome: 'passed' });
      expect(
        await entries(s.c.tenantId, 'permit_inspection.passed', second),
      ).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            permitId: permit.id,
            cycle: 2,
            certificateNumber: expect.stringMatching(/^WC-\d{6}$/) as string,
          }) as unknown,
        }),
      ]);
    });
  });

  describe('catalog completeness', () => {
    it('every R11a-2 entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11A2_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11A2_COVERAGE].sort());
    });
  });
});

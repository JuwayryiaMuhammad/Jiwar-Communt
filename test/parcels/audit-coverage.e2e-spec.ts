import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { call } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelHelpers, parcelScenes } from '../setup/parcels';

/**
 * One scenario per parcels catalog entry (ADR 0014, 0035): actor, target,
 * changes and metadata — ids, the carrier, the pieces, a reason code or a
 * method; never a name (the label's, a delegate's), a code or a file id.
 */
const covered = new Set<string>();

describe('Audit coverage — parcels', () => {
  let h: HttpHarness;
  let w: World;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    read = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(w.a.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  const unitCode = () =>
    w.helpers.asManager(
      w.a,
      async () =>
        (
          await w.helpers.prisma.tenant.unit.findUniqueOrThrow({
            where: { id: w.a.homeUnitId },
          })
        ).code,
    );

  describe('receiving', () => {
    it('parcel.received — by the guard on shift', async () => {
      const res = await parcelHelpers(h).receive(
        w.a.tokens.guard,
        await unitCode(),
        { carrier: 'bosta', pieces: 2, labelName: 'AUDIT-LABEL' },
      );
      expect(res.status).toBe(201);
      const { id, number } = res.body as { id: string; number: number };
      const row = await single('parcel.received', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: w.a.ids.guard,
        targetType: 'parcel',
        metadata: { carrier: 'bosta', pieces: 2, parcelNumber: number },
      });
      expect(JSON.stringify(row)).not.toContain('AUDIT-LABEL');
    });
  });

  describe('the residents', () => {
    it('parcel.rejected, parcel.delegate_authorized and parcel.delegate_revoked — by the unit’s residents, and by the system when the authorizer leaves', async () => {
      const s = parcelScenes(w);
      const home = await s.household();
      const post = (token: string, path: string, body: object = {}) =>
        call(w, 'POST', path, { token, body });
      const rejected = await s.receive(home.unitCode);
      expect(
        (
          await post(home.owner.token, `/me/parcels/${rejected.id}/reject`, {
            reasonCode: 'not_ours',
          })
        ).status,
      ).toBe(200);
      expect(await single('parcel.rejected', rejected.id)).toMatchObject({
        actorType: 'account',
        actorId: home.owner.id,
        targetType: 'parcel',
        metadata: { reasonCode: 'not_ours' },
      });

      const parcel = await s.receive(home.unitCode, {
        labelName: 'AUDIT-LABEL',
      });
      expect(
        (
          await post(home.owner.token, `/me/parcels/${parcel.id}/delegate`, {
            name: 'AUDIT-DELEGATE',
          })
        ).status,
      ).toBe(201);
      const authorized = await single('parcel.delegate_authorized', parcel.id);
      expect(authorized).toMatchObject({
        actorId: home.owner.id,
        targetType: 'parcel',
      });
      expect(
        (
          await post(
            home.member.token,
            `/me/parcels/${parcel.id}/delegate/revoke`,
          )
        ).status,
      ).toBe(204);
      const revoked = await read.tenant(w.a.tenantId, {
        action: 'parcel.delegate_revoked',
        targetId: parcel.id,
      });
      expect(revoked).toHaveLength(1);
      covered.add('parcel.delegate_revoked');
      expect(revoked[0]).toMatchObject({
        actorId: home.member.id,
        metadata: { reasonCode: 'revoked' },
      });
      expect(JSON.stringify([authorized, ...revoked])).not.toMatch(/AUDIT-/);

      // The system's end of a delegate whose authorizer left, recorded the same.
      const second = await s.receive(home.unitCode);
      await post(home.member.token, `/me/parcels/${second.id}/delegate`, {
        name: 'AUDIT-DELEGATE-2',
      }).expect(201);
      await w.helpers.asManager(w.a, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(home.member.id, { status: 'inactive' }),
      );
      const left = await read.tenant(w.a.tenantId, {
        action: 'parcel.delegate_revoked',
        targetId: second.id,
      });
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({
        targetType: 'parcel',
        metadata: { reasonCode: 'authorizer_left' },
      });
      expect(JSON.stringify(left)).not.toMatch(/AUDIT-/);
    });
  });

  describe('catalog completeness', () => {
    it('every parcels entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PARCELS_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PARCELS_COVERAGE].sort());
    });
  });
});

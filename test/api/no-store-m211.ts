import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { fileHelpers } from '../setup/files';
import { groupOfferRow, groupParticipantRow } from '../setup/market-rows';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of transfers, closed units and the
 * market's completion (ADR 0083), in A: an emergency entry's photos are
 * presigned, and the group offers' routes are all no-store.
 */
export function m211Calls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const supervisor = () => world().a.tokens.supervisor;
  const manager = () => world().a.tokens.manager;
  const owner = () => world().a.tokens.owner;
  const entry = async (): Promise<string> =>
    (
      (
        await call(world(), 'POST', '/staff/security/unit-entries', {
          token: supervisor(),
          body: {
            unitId: world().a.homeUnitId,
            reasonCode: 'water_leak',
            enteredAt: new Date().toISOString(),
            witnessIds: [world().a.ids.guard],
          },
        }).expect(201)
      ).body as { id: string }
    ).id;
  /** A group offer of A's, confirmed, the owner joined: its id. */
  const confirmed = async (): Promise<string> => {
    const w = world();
    return w.helpers.asManager(w.a, () =>
      w.h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const id = await groupOfferRow(tx, {
          tenantId: w.a.tenantId,
          createdById: w.a.ids.manager,
        });
        await groupParticipantRow(tx, {
          tenantId: w.a.tenantId,
          offerId: id,
          accountId: w.a.ids.owner,
          unitId: w.a.homeUnitId,
        });
        await tx.groupOffer.update({
          where: { id },
          data: { status: 'confirmed', closedAt: new Date() },
        });
        return id;
      }),
    );
  };
  return {
    'POST /staff/security/unit-entries': () =>
      call(world(), 'POST', '/staff/security/unit-entries', {
        token: supervisor(),
        body: {
          unitId: world().a.homeUnitId,
          reasonCode: 'smoke',
          enteredAt: new Date().toISOString(),
          witnessIds: [world().a.ids.guard],
        },
      }),
    'GET /staff/security/unit-entries': () =>
      call(world(), 'GET', '/staff/security/unit-entries', {
        token: supervisor(),
      }),
    'GET /staff/security/unit-entries/{id}': async () =>
      call(world(), 'GET', `/staff/security/unit-entries/${await entry()}`, {
        token: supervisor(),
      }),
    'POST /staff/security/unit-entries/{id}/report': async () => {
      const id = await entry();
      return call(
        world(),
        'POST',
        `/staff/security/unit-entries/${id}/report`,
        {
          token: supervisor(),
          body: {
            outcome: 'resolved',
            note: 'Closed the valve.',
            photoFileIds: [
              await fileHelpers(world().h).ready(
                supervisor(),
                'unit_entry_photo',
              ),
            ],
          },
        },
      );
    },
    'GET /units/{unitId}/entries': () =>
      call(world(), 'GET', `/units/${world().a.homeUnitId}/entries`, {
        token: owner(),
      }),
    'POST /staff/group-offers/{id}/contract': async () =>
      call(
        world(),
        'POST',
        `/staff/group-offers/${await confirmed()}/contract`,
        { token: manager(), body: { finalPrice: '900' } },
      ),
    'POST /market/group-offers/{id}/reconfirm': async () => {
      const id = await confirmed();
      await call(world(), 'POST', `/staff/group-offers/${id}/contract`, {
        token: manager(),
        body: { finalPrice: '1000' },
      }).expect(200);
      return call(world(), 'POST', `/market/group-offers/${id}/reconfirm`, {
        token: owner(),
      });
    },
  };
}

import type { Response } from 'supertest';
import type { World } from '../api/world';
import type { Compound } from './community';
import { fileHelpers } from './files';
import { gateHelpers } from './gate';
import { API, type HttpHarness } from './http-app';

/** Parcels for the suites (ADR 0035): logged through the API, as a guard. */
export function parcelHelpers(h: HttpHarness) {
  const f = fileHelpers(h);

  /** A finalized `parcel_photo` of the caller's. */
  const photo = (token: string) => f.ready(token, 'parcel_photo', 'image/jpeg');

  /** `POST /gate/parcels` as the guard holding `token` (on duty). */
  async function receive(
    token: string,
    unitCode: string,
    over: Record<string, unknown> = {},
  ): Promise<Response> {
    // The photo first: a supertest request is built (and starts the shared
    // HTTP server) before it is sent, so uploading in between left the suite
    // without a server (ECONNREFUSED on every later request).
    const photoFileId = await photo(token);
    return h
      .http()
      .post(`${API}/gate/parcels`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        unitCode,
        carrier: 'dhl',
        pieces: 2,
        photoFileId,
        ...over,
      });
  }

  /** A guard of the compound on duty at a gate of its own, with a token. */
  async function guardOnDuty(compound: Compound) {
    const duty = await gateHelpers(h).onDuty(compound);
    const token = await h.tokenFor({
      sub: duty.guardId,
      tid: compound.tenantId,
      typ: 'staff',
    });
    return { ...duty, token };
  }

  return { photo, receive, guardOnDuty };
}

/** A household of compound A: its unit, its primary and one family member. */
export interface Household {
  unitId: string;
  unitCode: string;
  owner: { id: string; token: string };
  member: { id: string; token: string; memberId: string };
}

/** Parcel scenes on a world's compound A (ADR 0035). */
export function parcelScenes(w: World) {
  const p = parcelHelpers(w.h);

  /** A fresh unit, its owner-resident (the primary) and, optionally, a member. */
  async function household(): Promise<Household> {
    const unit = await w.helpers.unit(w.a);
    const owner = await w.helpers.resident(w.a, [unit.id]);
    const family = await w.helpers.joinFamily(w.a, unit.id, owner);
    return {
      unitId: unit.id,
      unitCode: unit.code,
      owner: {
        id: owner.id,
        token: await w.tokenFor(w.a, owner.id, 'resident'),
      },
      member: {
        id: family.id,
        memberId: family.memberId,
        token: await w.tokenFor(w.a, family.id, 'family'),
      },
    };
  }

  /** A parcel for the unit, received by A's guard on duty. */
  async function receive(unitCode: string, over: Record<string, unknown> = {}) {
    const res = await p.receive(w.a.tokens.guard, unitCode, over);
    if (res.status !== 201)
      throw new Error(`receive: ${res.status} ${res.text}`);
    return res.body as { id: string; number: number };
  }

  return { ...p, household, receive };
}

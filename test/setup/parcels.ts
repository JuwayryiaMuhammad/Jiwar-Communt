import type { Response } from 'supertest';
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

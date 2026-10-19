import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { photoPurgeAfter } from '../../src/gate/entries/entry-photo-rules';
import { dbClock, today } from '../setup/compound-clock';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each of the routes of ADR 0056, as A's guard (on shift at
 * A's gate) or A's manager.
 */
export function gateCompletionCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as =
    (who: 'manager' | 'guard') =>
    (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[who],
        body: payload,
      });
  const manager = as('manager');
  const guard = as('guard');
  const id = (res: Response) => (res.body as { id: string }).id;
  /** A visitor's exception A's guard raises at A's gate: its id. */
  const raise = () =>
    guard('POST', '/gate/field-exceptions', {
      kind: 'visitor_without_pass',
      reasonCode: 'resident_unreachable',
      unitCode: world().a.homeUnitCode,
    });
  /**
   * A visitor A's guard let in on an approved exception, with a photo (the
   * file row written directly: no upload here): the entry's id.
   */
  const photographed = async (): Promise<string> => {
    const x = id(await raise());
    await manager('POST', `/staff/gate/field-exceptions/${x}/decide`, {
      decision: 'approve',
    });
    const entry = await guard('POST', '/gate/entries', {
      subjectType: 'field_exception',
      subjectId: x,
      direction: 'in',
    });
    const w = world();
    const occurredAt = new Date(
      (entry.body as { occurredAt: string }).occurredAt,
    );
    await w.helpers.asManager(w.a, () =>
      w.h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const fileId = newId();
        const at = dbClock();
        await tx.storedFile.create({
          data: {
            id: fileId,
            tenantId: w.a.tenantId,
            purpose: 'visitor_photo',
            contentType: 'image/png',
            sizeBytes: 100,
            status: 'ready',
            uploadExpiresAt: at,
            finalizedAt: at,
            attachedAt: at,
          },
        });
        await tx.gateEntryPhoto.create({
          data: {
            tenantId: w.a.tenantId,
            entryId: id(entry),
            fileId,
            subjectType: 'field_exception',
            subjectId: x,
            gateId: w.a.gateId,
            unitId: w.a.homeUnitId,
            takenById: w.a.ids.guard,
            enteredAt: occurredAt,
            purgeAfter: photoPurgeAfter(occurredAt),
          },
        });
      }),
    );
    return id(entry);
  };
  /** An incident A's guard reported: its id. */
  const incident = async () =>
    id(
      await guard('POST', '/gate/incidents', {
        type: 'hazard',
        severity: 'low',
        placeId: world().aPlaceId,
        occurredAt: dbClock().toISOString(),
        description: 'No-store incident with evidence',
      }),
    );
  const evidence = (path: string, as: typeof guard) => async () => {
    const entryId = await photographed();
    return as('POST', path.replace('{id}', await incident()), {
      kind: 'visitor_photo',
      entryId,
    });
  };
  /** A signature's PNG of the caller's, ready (the row written directly). */
  const signatureFile = async (owner: 'manager' | 'guard') => {
    const w = world();
    const fileId = newId();
    await w.helpers.asManager(w.a, () =>
      w.h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const at = dbClock();
        await tx.storedFile.create({
          data: {
            id: fileId,
            tenantId: w.a.tenantId,
            ownerAccountId: w.a.ids[owner],
            purpose: 'incident_signature',
            contentType: 'image/png',
            sizeBytes: 100,
            status: 'ready',
            uploadExpiresAt: new Date(at.getTime() + 600_000),
            finalizedAt: at,
          },
        });
      }),
    );
    return fileId;
  };
  let plates = 0;
  /** A tanker A's guard lets in: a plate no other call uses. */
  const enter = () =>
    guard('POST', '/gate/service-vehicles', {
      plate: `NS ${1000 + ++plates}`,
      kind: 'tanker',
      company: 'No Store Water',
    });
  return {
    'GET /gate/inside': () => guard('GET', '/gate/inside'),
    'GET /gate/directory': () => guard('GET', '/gate/directory'),
    'POST /gate/vehicle-passages': () =>
      guard('POST', '/gate/vehicle-passages', {
        vehicleId: world().aVehicleId,
        direction: 'in',
      }),
    'POST /staff/gate/log-search': () =>
      manager('POST', '/staff/gate/log-search', {
        from: today(),
        to: today(),
      }),
    'GET /staff/gate/reports/traffic': () =>
      manager('GET', '/staff/gate/reports/traffic'),
    'GET /staff/gate/reports/traffic/export': () =>
      manager('GET', '/staff/gate/reports/traffic/export'),
    'GET /gate/entries/{id}/photo': async () =>
      manager('GET', `/gate/entries/${await photographed()}/photo`),
    'POST /gate/incidents/{id}/evidence': evidence(
      '/gate/incidents/{id}/evidence',
      guard,
    ),
    'GET /gate/incidents/{id}/evidence': async () =>
      guard('GET', `/gate/incidents/${await incident()}/evidence`),
    'POST /staff/security/incidents/{id}/evidence': evidence(
      '/staff/security/incidents/{id}/evidence',
      manager,
    ),
    'GET /staff/security/incidents/{id}/evidence': async () =>
      manager('GET', `/staff/security/incidents/${await incident()}/evidence`),
    'POST /gate/incidents/{id}/signatures': async () =>
      guard('POST', `/gate/incidents/${await incident()}/signatures`, {
        role: 'author',
        fileId: await signatureFile('guard'),
      }),
    'GET /gate/incidents/{id}/signatures': async () =>
      guard('GET', `/gate/incidents/${await incident()}/signatures`),
    'POST /staff/security/incidents/{id}/signatures': async () =>
      manager(
        'POST',
        `/staff/security/incidents/${await incident()}/signatures`,
        { role: 'reviewer', fileId: await signatureFile('manager') },
      ),
    'GET /staff/security/incidents/{id}/signatures': async () =>
      manager(
        'GET',
        `/staff/security/incidents/${await incident()}/signatures`,
      ),
    'POST /gate/service-vehicles': enter,
    'POST /gate/service-vehicles/{id}/exit': async () =>
      guard('POST', `/gate/service-vehicles/${id(await enter())}/exit`),
    'GET /gate/service-vehicles': () => guard('GET', '/gate/service-vehicles'),
    'GET /staff/gate/service-vehicles': () =>
      manager('GET', '/staff/gate/service-vehicles'),
    'GET /staff/gate/settings': () => manager('GET', '/staff/gate/settings'),
    'PATCH /staff/gate/settings': () =>
      manager('PATCH', '/staff/gate/settings', { exceptionAnswerMinutes: 10 }),
    'POST /gate/field-exceptions': raise,
    'GET /gate/field-exceptions/{id}': async () =>
      guard('GET', `/gate/field-exceptions/${id(await raise())}`),
    'POST /gate/field-exceptions/{id}/withdraw': async () =>
      guard('POST', `/gate/field-exceptions/${id(await raise())}/withdraw`),
    'GET /staff/gate/field-exceptions': () =>
      manager('GET', '/staff/gate/field-exceptions'),
    'GET /staff/gate/field-exceptions/{id}': async () =>
      manager('GET', `/staff/gate/field-exceptions/${id(await raise())}`),
    'POST /staff/gate/field-exceptions/{id}/decide': async () =>
      manager(
        'POST',
        `/staff/gate/field-exceptions/${id(await raise())}/decide`,
        {
          decision: 'reject',
          reasonCode: 'other',
        },
      ),
  };
}

import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { superuserSql } from '../setup/governance';
import { plate } from '../setup/vehicles';
import { call } from './request';
import type { World } from './world';

/** A setup call that must have made what it asked (awaited: a response). */
function created(res: Response): Response {
  if (res.status !== 201)
    throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** Numbers of the rows written straight in: far above the counter's. */
let written = 900_000;

/**
 * A real call for each decision appeal route (ADR 0059), as A's owner (the
 * home's primary) or A's manager. A's manager took the decisions lodged
 * here, so the appeals a manager decides are written straight in, with no
 * decider to conflict.
 */
export function decisionAppealCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as =
    (persona: 'manager' | 'owner') =>
    (method: 'GET' | 'POST', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[persona],
        body: payload,
      });
  const manager = as('manager');
  const owner = as('owner');
  const id = (res: Response) => (res.body as { id: string }).id;

  /** A vehicle of A's home, registered by its owner and rejected: its id. */
  const aRejectedVehicle = async () => {
    const vehicleId = id(
      created(
        await owner('POST', `/units/${world().a.homeUnitId}/vehicles`, {
          plate: plate(),
          makeAndModel: 'Hyundai Elantra',
          color: 'Silver',
          type: 'car',
        }),
      ),
    );
    await manager('POST', `/staff/vehicles/${vehicleId}/reject`, {
      version: 1,
      reasonCode: 'plate_mismatch',
    }).expect(200);
    return vehicleId;
  };
  const lodgeOne = async () =>
    owner('POST', '/decision-appeals', {
      kind: 'vehicle_rejection',
      subjectId: await aRejectedVehicle(),
      grounds: 'No-store grounds',
    });
  const anAppeal = async () => id(created(await lodgeOne()));
  /** A pending appeal nobody of A decided the subject of. */
  const aWritten = async (status: 'pending' | 'follow_up' = 'pending') => {
    const appealId = newId();
    const w = world().a;
    await superuserSql(
      `INSERT INTO decision_appeals (id, tenant_id, number, kind, subject_id, unit_id,
              appellant_account_id, grounds, decision_at, lodged_at)
       VALUES ($1, $2, $3, 'permit_rejection', gen_random_uuid(), $4, $5,
               'No-store grounds', now(), now())`,
      [appealId, w.tenantId, ++written, w.homeUnitId, w.ids.owner],
    );
    if (status === 'follow_up')
      await superuserSql(
        `UPDATE decision_appeals SET status = 'overturned', decided_at = now(),
                decided_by_account_id = $2, decider_role_key = 'manager',
                rationale = 'No-store rationale', effect = 'follow_up',
                effect_reason = 'needs_review'
          WHERE id = $1`,
        [appealId, w.ids.manager],
      );
    return appealId;
  };

  return {
    'POST /decision-appeals': () => lodgeOne(),
    'GET /decision-appeals': () => owner('GET', '/decision-appeals'),
    'GET /decision-appeals/{id}': async () =>
      owner('GET', `/decision-appeals/${await anAppeal()}`),
    'POST /decision-appeals/{id}/withdraw': async () =>
      owner('POST', `/decision-appeals/${await anAppeal()}/withdraw`),
    'GET /staff/decision-appeals': () =>
      manager('GET', '/staff/decision-appeals'),
    'GET /staff/decision-appeals/{id}': async () =>
      manager('GET', `/staff/decision-appeals/${await anAppeal()}`),
    'POST /staff/decision-appeals/{id}/decide': async () =>
      manager('POST', `/staff/decision-appeals/${await aWritten()}/decide`, {
        outcome: 'upheld',
        rationale: 'No-store rationale',
      }),
    'POST /staff/decision-appeals/{id}/followed-up': async () =>
      manager(
        'POST',
        `/staff/decision-appeals/${await aWritten('follow_up')}/followed-up`,
      ),
  };
}

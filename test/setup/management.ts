import type { Server } from 'node:http';
import request from 'supertest';
import { communityHelpers, type Compound } from './community';
import { API, type HttpHarness } from './http-app';

/** An account of the suite with a token of its own. */
export interface Who {
  id: string;
  token: string;
}

/**
 * Helpers for the management request suites (ADR 0039): a compound with its
 * manager, a household (its primary and a family member) and calls over
 * HTTP as any of them.
 */
export function managementHelpers(h: HttpHarness) {
  const x = communityHelpers(h);

  async function who(
    c: Compound,
    id: string,
    type: 'staff' | 'manager' | 'resident' | 'family',
  ): Promise<Who> {
    return {
      id,
      token: await h.tokenFor({ sub: id, tid: c.tenantId, typ: type }),
    };
  }

  /** A compound, its manager, a unit and the unit's owner (its primary). */
  async function setUp() {
    const c = await x.compound();
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    return {
      c,
      unit,
      manager: await who(c, c.managerId, 'manager'),
      owner: await who(c, owner.id, 'resident'),
    };
  }

  const http = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
    body?: object,
    headers: Record<string, string> = {},
  ) => {
    const agent = request(h.app.getHttpServer() as Server);
    let req = agent[method](`${API}${path}`).set(
      'Authorization',
      `Bearer ${token}`,
    );
    for (const [name, value] of Object.entries(headers))
      req = req.set(name, value);
    return method === 'get' || method === 'delete' ? req : req.send(body ?? {});
  };

  return { x, who, setUp, http };
}

export type ManagementSetUp = Awaited<
  ReturnType<ReturnType<typeof managementHelpers>['setUp']>
>;

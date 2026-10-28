import type { Response } from 'supertest';
import { day } from '../setup/compound-clock';
import { nationalIdFor } from '../setup/fixtures';
import { uniqueEmail, uniquePhone } from '../setup/http-app';
import { call } from './request';
import type { World } from './world';

/** A real call for each no-store route of ADR 0063's proxies. */
export function proxyCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  return {
    // The link's token is shown once: an owner of A's home appoints one.
    'POST /units/{unitId}/proxies': () => {
      const w = world();
      return call(w, 'POST', `/units/${w.a.homeUnitId}/proxies`, {
        token: w.a.tokens.owner,
        body: {
          fullName: 'Nadia Proxy',
          email: uniqueEmail('proxy-ns'),
          phone: uniquePhone(),
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(),
          scopes: ['inspections'],
          endsOn: day(90),
        },
      });
    },
  };
}

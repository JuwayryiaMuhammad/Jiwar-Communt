import type { Response } from 'supertest';
import { at, day } from '../setup/compound-clock';
import { shiftWindow } from '../setup/partners';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0060, as A's owner or A's
 * manager, on a partner A's manager lists for the call.
 */
export function partnerCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as =
    (who: 'manager' | 'owner') =>
    (
      method: 'GET' | 'POST' | 'PATCH' | 'PUT',
      path: string,
      payload?: object,
    ) =>
      call(world(), method, path, {
        token: world().a.tokens[who],
        body: payload,
      });
  const manager = as('manager');
  const owner = as('owner');
  /** A partner of A's, cleaning, open all week. */
  const partner = async (): Promise<string> => {
    const created = await manager('POST', '/staff/partners', {
      nameEn: 'Call cleaners',
      nameAr: 'منظفون',
      businessPhone: '+20225550101',
      services: [
        { category: 'home_services', subcategoryId: world().aSubcategoryId },
      ],
    });
    return (created.body as { id: string }).id;
  };
  /** A's owner asks A's desk partner for a cleaning: the request's id. */
  const request = async (): Promise<string> => {
    // The suite makes more requests than an account may keep open by default.
    await manager('PATCH', '/staff/partner-settings', { maxLiveRequests: 20 });
    await owner('POST', '/me/consents/grant', {
      code: 'partner_share_home_services',
      version: 1,
    });
    const created = await owner('POST', '/partner-requests', {
      partnerId: world().aPartnerId,
      unitId: world().a.homeUnitId,
      category: 'home_services',
      subcategoryId: world().aSubcategoryId,
      windowStartsAt: at(day(2), 10).toISOString(),
      windowEndsAt: at(day(2), 12).toISOString(),
    });
    return (created.body as { id: string }).id;
  };
  /** On A's partner's desk, with its live link. */
  const desk = (path: string, payload: object = {}) =>
    call(world(), 'POST', `/public/partner-desk${path}`, {
      body: { token: world().aDeskToken, ...payload },
    });
  const proposal = () => ({
    windowStartsAt: at(day(3), 14).toISOString(),
    windowEndsAt: at(day(3), 16).toISOString(),
  });
  /** A request A's partner accepted. */
  const accepted = async (): Promise<string> => {
    const id = await request();
    await desk(`/requests/${id}/accept`, { staffCount: 2 });
    return id;
  };
  /** A request whose partner proposed another window. */
  const proposed = async (): Promise<string> => {
    const id = await request();
    await desk(`/requests/${id}/propose`, proposal());
    return id;
  };
  /** A request A's partner accepted and A's owner then said was done. */
  const done = async (): Promise<string> => {
    const id = await accepted();
    await shiftWindow(id, 'started');
    await owner('POST', `/partner-requests/${id}/done`);
    return id;
  };
  /** A's owner's complaint about a request done: its id. */
  const complaint = async (): Promise<string> => {
    const res = await owner(
      'POST',
      `/partner-requests/${await done()}/complaint`,
      { reason: 'late', compensationAsk: 'none', message: 'Two hours late.' },
    );
    return (res.body as { id: string }).id;
  };
  return {
    'POST /partner-requests/{id}/rating': async () =>
      owner('POST', `/partner-requests/${await done()}/rating`, { stars: 5 }),
    'POST /partner-requests/{id}/complaint': async () =>
      owner('POST', `/partner-requests/${await done()}/complaint`, {
        reason: 'poor_quality',
        compensationAsk: 'refund',
        requestedAmount: '120',
        message: 'Nothing was cleaned.',
      }),
    'GET /staff/partner-complaints': async () => {
      await complaint();
      return manager('GET', '/staff/partner-complaints');
    },
    'GET /staff/partner-complaints/{id}': async () =>
      manager('GET', `/staff/partner-complaints/${await complaint()}`),
    'POST /staff/partner-complaints/{id}/decide': async () =>
      manager('POST', `/staff/partner-complaints/${await complaint()}/decide`, {
        outcome: 'upheld',
        compensation: 'credit_note',
      }),
    'GET /staff/partner-ratings': () =>
      manager('GET', '/staff/partner-ratings'),
    'POST /partner-requests': async () => {
      await request();
      return owner('GET', '/partner-requests').then(async () =>
        owner('POST', '/partner-requests', {
          partnerId: world().aPartnerId,
          unitId: world().a.homeUnitId,
          category: 'home_services',
          windowStartsAt: at(day(4), 10).toISOString(),
          windowEndsAt: at(day(4), 11).toISOString(),
        }),
      );
    },
    'GET /partner-requests': async () => {
      await request();
      return owner('GET', '/partner-requests');
    },
    'GET /partner-requests/{id}': async () =>
      owner('GET', `/partner-requests/${await request()}`),
    'POST /partner-requests/{id}/cancel': async () =>
      owner('POST', `/partner-requests/${await request()}/cancel`, {
        reasonCode: 'no_longer_needed',
      }),
    'POST /partner-requests/{id}/accept-proposal': async () =>
      owner('POST', `/partner-requests/${await proposed()}/accept-proposal`),
    'POST /partner-requests/{id}/decline-proposal': async () =>
      owner('POST', `/partner-requests/${await proposed()}/decline-proposal`),
    'POST /partner-requests/{id}/done': async () => {
      const id = await accepted();
      await shiftWindow(id, 'started');
      return owner('POST', `/partner-requests/${id}/done`);
    },
    'POST /partner-requests/{id}/no-show': async () => {
      const id = await accepted();
      await shiftWindow(id, 'ended');
      return owner('POST', `/partner-requests/${id}/no-show`);
    },
    'GET /staff/partner-requests': () =>
      manager('GET', '/staff/partner-requests'),
    'GET /staff/partner-requests/{id}': async () =>
      manager('GET', `/staff/partner-requests/${await request()}`),
    'POST /staff/partner-requests/{id}/accept': async () =>
      manager('POST', `/staff/partner-requests/${await request()}/accept`, {
        staffCount: 1,
      }),
    'POST /staff/partner-requests/{id}/decline': async () =>
      manager('POST', `/staff/partner-requests/${await request()}/decline`, {
        reasonCode: 'unavailable',
      }),
    'POST /staff/partner-requests/{id}/propose': async () =>
      manager(
        'POST',
        `/staff/partner-requests/${await request()}/propose`,
        proposal(),
      ),
    'POST /staff/partner-requests/{id}/done': async () => {
      const id = await accepted();
      await shiftWindow(id, 'started');
      return manager('POST', `/staff/partner-requests/${id}/done`);
    },
    'POST /staff/partner-requests/{id}/cancel': async () =>
      manager('POST', `/staff/partner-requests/${await accepted()}/cancel`, {
        reasonCode: 'emergency',
      }),
    // A fresh partner's: A's desk partner keeps the World's link.
    'POST /staff/partners/{id}/desk-link': async () =>
      manager('POST', `/staff/partners/${await partner()}/desk-link`),
    'POST /public/partner-desk/lookup': () => desk('/lookup'),
    'POST /public/partner-desk/requests/{id}/accept': async () =>
      desk(`/requests/${await request()}/accept`, { staffCount: 1 }),
    'POST /public/partner-desk/requests/{id}/decline': async () =>
      desk(`/requests/${await request()}/decline`, {
        reasonCode: 'unavailable',
      }),
    'POST /public/partner-desk/requests/{id}/propose': async () =>
      desk(`/requests/${await request()}/propose`, proposal()),
    'POST /public/partner-desk/requests/{id}/done': async () => {
      const id = await accepted();
      await shiftWindow(id, 'started');
      return desk(`/requests/${id}/done`);
    },
    'POST /public/partner-desk/requests/{id}/cancel': async () =>
      desk(`/requests/${await accepted()}/cancel`, { reasonCode: 'emergency' }),
    'GET /partner-categories': () => owner('GET', '/partner-categories'),
    'GET /partners': async () => {
      await partner();
      return owner('GET', '/partners');
    },
    'GET /partners/{id}': async () =>
      owner('GET', `/partners/${await partner()}`),
    'GET /staff/partners': () => manager('GET', '/staff/partners'),
    'GET /staff/partners/{id}': async () =>
      manager('GET', `/staff/partners/${await partner()}`),
    'POST /staff/partners': () =>
      manager('POST', '/staff/partners', {
        nameEn: 'New cleaners',
        nameAr: 'منظفون',
        businessPhone: '+20225550102',
        services: [{ category: 'home_services' }],
      }),
    'PATCH /staff/partners/{id}': async () =>
      manager('PATCH', `/staff/partners/${await partner()}`, {
        homeVisit: true,
      }),
    'PUT /staff/partners/{id}/services': async () =>
      manager('PUT', `/staff/partners/${await partner()}/services`, {
        services: [{ category: 'pets' }],
      }),
    'PUT /staff/partners/{id}/hours': async () =>
      manager('PUT', `/staff/partners/${await partner()}/hours`, {
        windows: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
      }),
    'PUT /staff/partners/{id}/prices': async () =>
      manager('PUT', `/staff/partners/${await partner()}/prices`, {
        items: [
          { nameEn: 'Visit', nameAr: 'زيارة', price: '150', unit: 'visit_fee' },
        ],
      }),
    'POST /staff/partners/{id}/suspend': async () =>
      manager('POST', `/staff/partners/${await partner()}/suspend`, {
        reasonCode: 'contract_ended',
      }),
    'POST /staff/partners/{id}/reinstate': async () => {
      const id = await partner();
      await manager('POST', `/staff/partners/${id}/suspend`, {
        reasonCode: 'partner_request',
      });
      return manager('POST', `/staff/partners/${id}/reinstate`);
    },
    'GET /staff/partner-subcategories': () =>
      manager('GET', '/staff/partner-subcategories'),
    'POST /staff/partner-subcategories': () =>
      manager('POST', '/staff/partner-subcategories', {
        category: 'home_services',
        key: `windows_${Date.now()}`,
        nameEn: 'Windows',
        nameAr: 'نوافذ',
      }),
    'PATCH /staff/partner-subcategories/{id}': () =>
      manager(
        'PATCH',
        `/staff/partner-subcategories/${world().aSubcategoryId}`,
        {
          position: 2,
        },
      ),
    'GET /staff/partner-settings': () =>
      manager('GET', '/staff/partner-settings'),
    'PATCH /staff/partner-settings': () =>
      manager('PATCH', '/staff/partner-settings', { newDays: 30 }),
  };
}

import type { Response } from 'supertest';
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
  return {
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

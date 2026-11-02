import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of announcements and the office queue
 * (ADR 0080), in A: as its manager, and as its owner for their own letters.
 * Each call that needs a thing to act on makes it first.
 */
export function officeQueueCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const manager = () => w().a.tokens.manager;
  const as = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: object,
    token = manager(),
  ) => call(w(), method, path, { token, ...(body ? { body } : {}) });
  const idOf = async (res: Promise<Response>) =>
    ((await res).body as { id: string }).id;

  const announcement = async () => {
    const id = await idOf(
      as('POST', '/community/announcements', {
        kind: 'general',
        titleEn: 'No-store',
        bodyEn: 'A call of the no-store suite.',
      }),
    );
    await as('POST', `/community/announcements/${id}/publish`, {});
    return id;
  };
  const template = () =>
    idOf(
      as('POST', '/community/announcement-templates', {
        name: `No-store ${Date.now()}-${Math.random()}`,
        titleEn: 'x',
        bodyEn: 'y',
      }),
    );
  const reply = () =>
    idOf(
      as('POST', '/management/reply-templates', {
        name: `No-store ${Date.now()}-${Math.random()}`,
        bodyEn: 'y',
      }),
    );
  const request = (unitId?: string) =>
    idOf(
      as(
        'POST',
        '/management-requests',
        {
          type: 'question',
          topicId: w().aManagementTopicId,
          body: 'A call of the no-store suite.',
          ...(unitId ? { unitId } : {}),
        },
        w().a.tokens.owner,
      ),
    );
  const letter = () =>
    idOf(
      as('POST', '/staff/official-letters', {
        kind: 'residence_confirmation',
        unitId: w().a.homeUnitId,
        accountId: w().a.ids.owner,
      }),
    );

  return {
    'GET /community/announcements/{id}/delivery': async () =>
      as('GET', `/community/announcements/${await announcement()}/delivery`),
    'POST /community/announcements/{id}/remind': async () =>
      as('POST', `/community/announcements/${await announcement()}/remind`),
    'GET /community/announcement-templates': () =>
      as('GET', '/community/announcement-templates'),
    'POST /community/announcement-templates': () =>
      as('POST', '/community/announcement-templates', {
        name: `No-store ${Date.now()}`,
        titleEn: 'x',
        bodyEn: 'y',
      }),
    'PATCH /community/announcement-templates/{id}': async () =>
      as('PATCH', `/community/announcement-templates/${await template()}`, {
        bodyEn: 'z',
      }),
    'DELETE /community/announcement-templates/{id}': async () =>
      as('DELETE', `/community/announcement-templates/${await template()}`),
    'POST /management/outreach': () =>
      as('POST', '/management/outreach', {
        residentAccountId: w().a.ids.owner,
        topicId: w().aManagementTopicId,
        body: 'The office writes.',
      }),
    'POST /management/requests/{id}/topic': async () => {
      const id = await request();
      const topics = (
        await as(
          'GET',
          '/management-request-topics',
          undefined,
          w().a.tokens.owner,
        )
      ).body as { data: { id: string; key: string }[] };
      // Not the release topic: a request moves onto it only to release a hold.
      const other = topics.data.find(
        (t) => t.id !== w().aManagementTopicId && t.key !== 'release_request',
      )!;
      return as('POST', `/management/requests/${id}/topic`, {
        topicId: other.id,
      });
    },
    'POST /management/requests/{id}/convert': async () =>
      as(
        'POST',
        `/management/requests/${await request(w().a.homeUnitId)}/convert`,
        {
          target: 'ticket',
          categoryId: w().aCategoryId,
          description: 'A call of the no-store suite.',
        },
      ),
    'GET /management/reply-templates': () =>
      as('GET', '/management/reply-templates'),
    'POST /management/reply-templates': () =>
      as('POST', '/management/reply-templates', {
        name: `No-store ${Date.now()}`,
        bodyEn: 'y',
      }),
    'PATCH /management/reply-templates/{id}': async () =>
      as('PATCH', `/management/reply-templates/${await reply()}`, {
        bodyAr: 'ز',
      }),
    'DELETE /management/reply-templates/{id}': async () =>
      as('DELETE', `/management/reply-templates/${await reply()}`),
    'GET /staff/official-letters': () => as('GET', '/staff/official-letters'),
    'POST /staff/official-letters': () =>
      as('POST', '/staff/official-letters', {
        kind: 'to_whom_it_may_concern',
        unitId: w().a.homeUnitId,
        accountId: w().a.ids.owner,
      }),
    'GET /staff/official-letters/{id}': async () =>
      as('GET', `/staff/official-letters/${await letter()}`),
    'POST /staff/official-letters/{id}/revoke': async () =>
      as('POST', `/staff/official-letters/${await letter()}/revoke`, {
        reasonCode: 'other',
      }),
    'GET /staff/official-letters/{id}/pdf': async () =>
      as('GET', `/staff/official-letters/${await letter()}/pdf`),
    'GET /me/official-letters': () =>
      as('GET', '/me/official-letters', undefined, w().a.tokens.owner),
    'GET /me/official-letters/{id}/pdf': async () =>
      as(
        'GET',
        `/me/official-letters/${await letter()}/pdf`,
        undefined,
        w().a.tokens.owner,
      ),
    'POST /public/letters/lookup': async () => {
      const id = await letter();
      const code = (
        (await as('GET', `/staff/official-letters/${id}`)).body as {
          verifyCode: string;
        }
      ).verifyCode;
      return call(w(), 'POST', '/public/letters/lookup', { body: { code } });
    },
    'GET /staff/units/{unitId}/correspondence': () =>
      as('GET', `/staff/units/${w().a.homeUnitId}/correspondence`),
  };
}

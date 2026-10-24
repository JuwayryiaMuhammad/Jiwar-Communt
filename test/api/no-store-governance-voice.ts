import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each route of the owners' voice (ADR 0059) but the
 * follow-up's (in no-store-board-matters, beside the approved requests):
 * A's owner proposes and objects; A's landlord, sitting on A's board,
 * decides and answers. `aPublication` publishes a decision of A's board.
 */
export function governanceVoiceCalls(
  world: () => World,
  sitting: () => Promise<void>,
  aPublication: () => Promise<string>,
): Record<string, () => Promise<Response>> {
  const as =
    (persona: 'landlord' | 'owner') =>
    (method: 'GET' | 'POST', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[persona],
        body: payload,
      });
  const landlord = as('landlord');
  const owner = as('owner');
  const id = (res: Response) => (res.body as { id: string }).id;
  const created = (res: Response) => {
    if (res.status !== 201)
      throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  /** A new open proposal of A's owner, the ones before withdrawn: three at most. */
  const aProposal = async () => {
    const mine = (await owner('GET', '/governance/agenda-proposals')).body as {
      data: { id: string; status: string }[];
    };
    for (const p of mine.data.filter((x) => x.status === 'open'))
      await owner('POST', `/governance/agenda-proposals/${p.id}/withdraw`);
    return owner('POST', '/governance/agenda-proposals', {
      title: 'A no-store proposal',
      body: 'Its words.',
    });
  };
  /** A decision just published, objected to by A's owner for their home. */
  const anObjected = async () => {
    const publicationId = await aPublication();
    created(
      await owner(
        'POST',
        `/governance/publications/${publicationId}/objections`,
        {
          unitId: world().a.homeUnitId,
          grounds: 'No-store grounds',
        },
      ),
    );
    return publicationId;
  };

  return {
    'POST /governance/agenda-proposals': () => aProposal(),
    'GET /governance/agenda-proposals': () =>
      owner('GET', '/governance/agenda-proposals'),
    'GET /governance/agenda-proposals/{id}': async () =>
      owner(
        'GET',
        `/governance/agenda-proposals/${id(created(await aProposal()))}`,
      ),
    'POST /governance/agenda-proposals/{id}/withdraw': async () =>
      owner(
        'POST',
        `/governance/agenda-proposals/${id(created(await aProposal()))}/withdraw`,
      ),
    'GET /board/agenda-proposals': async () => {
      await sitting();
      return landlord('GET', '/board/agenda-proposals');
    },
    'GET /board/agenda-proposals/{id}': async () => {
      const proposalId = id(created(await aProposal()));
      await sitting();
      return landlord('GET', `/board/agenda-proposals/${proposalId}`);
    },
    'POST /board/agenda-proposals/{id}/decide': async () => {
      const proposalId = id(created(await aProposal()));
      await sitting();
      return landlord('POST', `/board/agenda-proposals/${proposalId}/decide`, {
        outcome: 'accepted',
      });
    },
    'POST /governance/publications/{id}/objections': async () =>
      owner(
        'POST',
        `/governance/publications/${await aPublication()}/objections`,
        {
          unitId: world().a.homeUnitId,
          grounds: 'No-store grounds',
        },
      ),
    'GET /governance/objections': () => owner('GET', '/governance/objections'),
    'GET /board/publications/{id}/objections': async () => {
      const publicationId = await anObjected();
      await sitting();
      return landlord('GET', `/board/publications/${publicationId}/objections`);
    },
    'POST /board/publications/{id}/objections/answer': async () => {
      const publicationId = await anObjected();
      await sitting();
      return landlord(
        'POST',
        `/board/publications/${publicationId}/objections/answer`,
        { body: 'The board’s reasons.' },
      );
    },
  };
}

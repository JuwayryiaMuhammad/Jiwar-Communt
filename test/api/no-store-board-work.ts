import type { Response } from 'supertest';
import { today } from '../setup/compound-clock';
import { lapse } from '../setup/governance';
import { call, type Method } from './request';
import type { World } from './world';

const HOUR = 3_600_000;

/**
 * A real call for each route of the board's work (ADR 0075): A's manager
 * keeps the shares and the rules; A's landlord, sitting on A's board,
 * schedules, holds and follows up its meetings.
 */
export function boardWorkCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const as =
    (persona: 'landlord' | 'manager') =>
    (method: Method, path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[persona],
        body: payload,
      });
  const landlord = as('landlord');
  const manager = as('manager');
  const id = (res: Response) => (res.body as { id: string }).id;
  const ok = (res: Response) => {
    if (res.status >= 300)
      throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  /** A meeting of A's board, scheduled. */
  const aMeeting = async () => {
    await sitting();
    return landlord('POST', '/board/meetings', {
      kind: 'regular',
      title: 'A no-store meeting',
      scheduledAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    });
  };
  /** A meeting of A's board, held with nobody present. */
  const aHeld = async () => {
    const meetingId = id(ok(await aMeeting()));
    ok(
      await landlord('POST', `/board/meetings/${meetingId}/hold`, {
        presentMemberIds: [],
      }),
    );
    return meetingId;
  };
  /** An open action item of a held meeting, owned by A's landlord. */
  const anAction = async () =>
    landlord('POST', `/board/meetings/${await aHeld()}/actions`, {
      title: 'A no-store item',
      ownerAccountId: world().a.ids.landlord,
      dueOn: today(),
    });

  /**
   * A board of A's appointed through the API, so it has a handover pack
   * (the world's board is written as rows, without one): A's owner and
   * landlord on it.
   */
  const aBoardWithPack = async () => {
    await sitting();
    if ((await landlord('GET', '/board/handover-pack')).status === 200) return;
    const board = (await manager('GET', '/staff/governance/board')).body as {
      board: { id: string } | null;
    };
    if (board.board) await lapse(board.board.id);
    ok(
      await manager('POST', '/staff/governance/board/appoint', {
        seats: 15,
        endsAt: new Date(Date.now() + 9000 * HOUR).toISOString(),
        members: [world().a.ids.owner, world().a.ids.landlord].map(
          (accountId) => ({ accountId, role: 'member' }),
        ),
      }),
    );
  };
  /** A delivered handover of A's manager. */
  const aDelivered = async () => {
    ok(
      await manager('PUT', '/staff/governance/handover', {
        notes: 'No-store notes',
      }),
    );
    return manager('POST', '/staff/governance/handover/deliver');
  };

  return {
    'GET /board/handover-pack': async () => {
      await aBoardWithPack();
      return landlord('GET', '/board/handover-pack');
    },
    'GET /board/handover-pack/pdf': async () => {
      await aBoardWithPack();
      return landlord('GET', '/board/handover-pack/pdf');
    },
    'GET /staff/governance/handover': () =>
      manager('GET', '/staff/governance/handover'),
    'PUT /staff/governance/handover': () =>
      manager('PUT', '/staff/governance/handover', { notes: 'No-store' }),
    'POST /staff/governance/handover/deliver': () => aDelivered(),
    'GET /board/manager-handovers': async () => {
      await sitting();
      return landlord('GET', '/board/manager-handovers');
    },
    'GET /board/manager-handovers/{id}': async () => {
      const handoverId = id(ok(await aDelivered()));
      await sitting();
      return landlord('GET', `/board/manager-handovers/${handoverId}`);
    },
    'GET /board/manager-handovers/{id}/pdf': async () => {
      const handoverId = id(ok(await aDelivered()));
      await sitting();
      return landlord('GET', `/board/manager-handovers/${handoverId}/pdf`);
    },
    'GET /staff/governance/unit-shares': () =>
      manager('GET', '/staff/governance/unit-shares'),
    'PUT /staff/governance/unit-shares': () =>
      manager('PUT', '/staff/governance/unit-shares', {
        shares: [{ unitId: world().a.homeUnitId, share: '1' }],
      }),
    'GET /staff/governance/rules': () =>
      manager('GET', '/staff/governance/rules'),
    'PATCH /staff/governance/rules': () =>
      manager('PATCH', '/staff/governance/rules', { candidacyNoDues: false }),
    'GET /board/meetings': async () => {
      await sitting();
      return landlord('GET', '/board/meetings');
    },
    'POST /board/meetings': () => aMeeting(),
    'GET /board/meetings/{id}': async () =>
      landlord('GET', `/board/meetings/${id(ok(await aMeeting()))}`),
    'PATCH /board/meetings/{id}': async () =>
      landlord('PATCH', `/board/meetings/${id(ok(await aMeeting()))}`, {
        title: 'A no-store meeting, changed',
      }),
    'POST /board/meetings/{id}/hold': async () =>
      landlord('POST', `/board/meetings/${id(ok(await aMeeting()))}/hold`, {
        presentMemberIds: [],
      }),
    'POST /board/meetings/{id}/cancel': async () =>
      landlord('POST', `/board/meetings/${id(ok(await aMeeting()))}/cancel`, {
        reasonCode: 'postponed',
      }),
    'POST /board/meetings/{id}/minutes': async () => {
      const meetingId = await aHeld();
      const publicationId = id(
        ok(
          await landlord('POST', '/governance/publications', {
            kind: 'minutes',
            decidedOn: today(),
            titleEn: 'No-store minutes',
            bodyEn: 'Its words.',
          }),
        ),
      );
      return landlord('POST', `/board/meetings/${meetingId}/minutes`, {
        publicationId,
      });
    },
    'POST /board/meetings/{id}/actions': () => anAction(),
    'GET /board/meeting-actions': async () => {
      await sitting();
      return landlord('GET', '/board/meeting-actions');
    },
    'POST /board/meeting-actions/{id}/done': async () =>
      landlord(
        'POST',
        `/board/meeting-actions/${id(ok(await anAction()))}/done`,
        {},
      ),
    'POST /board/meeting-actions/{id}/cancel': async () =>
      landlord(
        'POST',
        `/board/meeting-actions/${id(ok(await anAction()))}/cancel`,
        { reasonCode: 'not_needed' },
      ),
  };
}

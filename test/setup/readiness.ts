import { assetHelpers } from './assets';
import { day } from './compound-clock';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

export interface ProgramRead {
  id: string;
  kind: string;
  title: string;
  startsOn: string;
  endsOn: string;
  copiedFromId: string | null;
  closedAt: string | null;
  readiness: {
    items: number;
    done: number;
    cancelled: number;
    open: number;
    percent: number | null;
    budget: string;
  };
}

export interface ItemRead {
  id: string;
  programId: string;
  kind: string;
  title: string;
  ownerId: string;
  dueOn: string;
  estimateAmount: string | null;
  contractId: string | null;
  checklistId: string | null;
  state: 'open' | 'done' | 'cancelled';
  decision: string | null;
  cancelReason: string | null;
  copiedFromId: string | null;
}

/**
 * Helpers for the readiness suites (ADR 0067): the asset set-up (a
 * manager, a maintenance supervisor, technicians, a unit with its owner),
 * and programs, items and maintenance contracts over HTTP as the manager.
 */
export function readinessHelpers(h: HttpHarness) {
  const a = assetHelpers(h);

  const setUp = (technicians = 1) => a.setUp(technicians);
  type SetUp = Awaited<ReturnType<typeof setUp>>;

  const newProgram = (s: SetUp, body: object = {}) =>
    a.http('post', '/maintenance/readiness/programs', s.manager.token, {
      kind: 'season',
      title: `Ramadan ${uniqueSuffix()}`,
      startsOn: day(30),
      endsOn: day(59),
      ...body,
    });

  async function program(s: SetUp, body: object = {}): Promise<ProgramRead> {
    return (await newProgram(s, body).expect(201)).body as ProgramRead;
  }

  const newItem = (s: SetUp, programId: string, body: object = {}) =>
    a.http(
      'post',
      `/maintenance/readiness/programs/${programId}/items`,
      s.manager.token,
      {
        kind: 'task',
        title: 'Service the pumps',
        ownerId: s.supervisor.id,
        dueOn: day(20),
        ...body,
      },
    );

  async function item(
    s: SetUp,
    programId: string,
    body: object = {},
  ): Promise<ItemRead> {
    return (await newItem(s, programId, body).expect(201)).body as ItemRead;
  }

  const getProgram = async (s: SetUp, id: string): Promise<ProgramRead> =>
    (
      await a
        .http('get', `/maintenance/readiness/programs/${id}`, s.manager.token)
        .expect(200)
    ).body as ProgramRead;

  const itemsOf = async (s: SetUp, id: string): Promise<ItemRead[]> =>
    (
      (
        await a
          .http(
            'get',
            `/maintenance/readiness/programs/${id}/items`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: ItemRead[] }
    ).data;

  const done = (s: SetUp, itemId: string, body: object = {}) =>
    a.http(
      'post',
      `/maintenance/readiness/items/${itemId}/done`,
      s.manager.token,
      body,
    );

  /** A maintenance contract of the compound's ending on `endsOn`; its id. */
  async function contract(s: SetUp, endsOn: string): Promise<string> {
    const res = await a
      .http('post', '/maintenance/contracts', s.manager.token, {
        code: `AMC-${uniqueSuffix()}`,
        kind: 'amc',
        vendorName: 'Lift vendor',
        startsOn: day(-300),
        endsOn,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  return {
    ...a,
    setUp,
    newProgram,
    program,
    newItem,
    item,
    getProgram,
    itemsOf,
    done,
    contract,
  };
}

export type ReadinessSetUp = Awaited<
  ReturnType<ReturnType<typeof readinessHelpers>['setUp']>
>;

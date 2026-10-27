import {
  UNIT_DOCUMENT_RETENTION_SWEEP,
  WARRANTY_SWEEP,
} from '../../src/community/units/unit-documents.service';
import type { Response } from 'supertest';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers } from '../setup/community';
import { day, daysLater } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { fileHelpers } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type Who } from '../setup/permits';
import { inAMonth } from '../api/routes/delegations';

interface Doc {
  id: string;
  title: string;
  visibility: string;
  holder: string;
  mine: boolean;
  code?: string;
}

/** A unit's document vault (ADR 0062): who sees, adds and deletes what. */
describe('Unit document vault', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let x: ReturnType<typeof communityHelpers>;
  let sweep: SweepRunner;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    x = communityHelpers(h);
    sweep = h.moduleRef.get(SweepRunner);
  }, 180_000);

  afterAll(() => h.close());

  /** A home with an owner (primary) and a tenant of another unit's owner. */
  async function home(name: string) {
    const s = await p.setUp(name);
    const tenantAccount = await x.resident(s.c, [s.home.id], 'tenant');
    const tenant = await p.who(s.c, tenantAccount.id, 'resident');
    return { ...s, tenant };
  }

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who,
    body?: object,
  ) => {
    const req = h.http()[method](`${API}${path}`);
    return req.set('Authorization', `Bearer ${who.token}`).send(body);
  };

  async function file(
    who: Who,
    unitId: string,
    body: Record<string, unknown>,
    staff = false,
  ) {
    const fileId = await fileHelpers(h).ready(
      who.token,
      'unit_document',
      'application/pdf',
    );
    return http(
      'post',
      `${staff ? '/staff' : ''}/units/${unitId}/documents`,
      who,
      { fileId, kind: 'manual', ...body },
    );
  }

  /** The response, once its status is the one expected. */
  const statusIs = (status: number) => (res: Response) => {
    expect(res.status).toBe(status);
    return res;
  };

  const titles = async (who: Who, unitId: string, staff = false) =>
    (
      (
        await http(
          'get',
          `${staff ? '/staff' : ''}/units/${unitId}/documents`,
          who,
        )
      ).body as Doc[]
    )
      .map((d) => d.title)
      .sort();

  it('each sees by visibility; the management never sees a resident’s own upload', async () => {
    const s = await home('Vault Court');
    for (const visibility of ['private', 'owners', 'occupants'])
      await file(s.alice, s.home.id, {
        title: `alice-${visibility}`,
        visibility,
      }).then(statusIs(201));
    await file(s.tenant, s.home.id, {
      title: 'tenant-owners',
      visibility: 'owners',
    }).then(statusIs(403));
    await file(
      s.manager,
      s.home.id,
      {
        title: 'handover',
        kind: 'handover_report',
        visibility: 'occupants',
      },
      true,
    ).then(statusIs(201));

    expect(await titles(s.alice, s.home.id)).toEqual([
      'alice-occupants',
      'alice-owners',
      'alice-private',
      'handover',
    ]);
    expect(await titles(s.tenant, s.home.id)).toEqual([
      'alice-occupants',
      'handover',
    ]);
    expect(await titles(s.manager, s.home.id, true)).toEqual(['handover']);

    // Delete: one's own only; the management, the unit's only.
    const list = (await http('get', `/units/${s.home.id}/documents`, s.alice))
      .body as Doc[];
    const shared = list.find((d) => d.title === 'alice-occupants')!;
    const refused = await http(
      'post',
      `/units/${s.home.id}/documents/${shared.id}/delete`,
      s.tenant,
    );
    expect((refused.body as Doc).code).toBe('UNIT_DOCUMENT_NOT_ALLOWED');
    await http(
      'post',
      `/staff/units/${s.home.id}/documents/${shared.id}/delete`,
      s.manager,
    ).expect(404);
    await http(
      'post',
      `/units/${s.home.id}/documents/${shared.id}/delete`,
      s.alice,
    ).expect(204);
    expect(await titles(s.tenant, s.home.id)).toEqual(['handover']);
  });

  it('a `documents` delegate reads and adds at the occupants’ level only', async () => {
    const s = await home('Vault Delegate Court');
    const bob = await x.joinFamily(s.c, s.home.id, s.alice);
    await http('post', `/units/${s.home.id}/delegations`, s.alice, {
      delegateAccountId: bob.accountId,
      scopes: ['documents'],
      expiresAt: inAMonth(),
    }).expect(201);
    const asBob = await p.who(s.c, bob.accountId, 'family');
    await file(s.alice, s.home.id, {
      title: 'alice-private',
      visibility: 'private',
    }).then(statusIs(201));
    await file(asBob, s.home.id, {
      title: 'bob-private',
      visibility: 'private',
    }).then(statusIs(403));
    const added = await file(asBob, s.home.id, {
      title: 'bob-shared',
      visibility: 'occupants',
    }).then(statusIs(201));
    expect((added.body as Doc).holder).toBe('occupancy');
    expect(await titles(asBob, s.home.id)).toEqual(['bob-shared']);
    // Filed for the primary: theirs to see.
    expect(await titles(s.alice, s.home.id)).toEqual([
      'alice-private',
      'bob-shared',
    ]);
  });

  it('a warranty tells the occupants once, 30 days before it ends', async () => {
    const s = await home('Vault Warranty Court');
    await file(
      s.manager,
      s.home.id,
      {
        title: 'AC warranty',
        kind: 'warranty',
        visibility: 'occupants',
        expiresOn: day(20),
      },
      true,
    ).then(statusIs(201));
    await file(s.alice, s.home.id, {
      title: 'Far warranty',
      kind: 'warranty',
      visibility: 'occupants',
      expiresOn: day(60),
    }).then(statusIs(201));
    // A warranty needs its date; nothing else takes one.
    await file(s.alice, s.home.id, {
      title: 'No date',
      kind: 'warranty',
      visibility: 'occupants',
    }).then(statusIs(400));
    await sweep.run(WARRANTY_SWEEP, new Date());
    await sweep.run(WARRANTY_SWEEP, new Date());
    const told = await x.asManager(s.c, () =>
      x.prisma.tenant.notification.findMany({
        where: {
          kind: 'unit_document.warranty_expiring',
          accountId: { in: [s.alice.id, s.tenant.id] },
        },
      }),
    );
    expect(told.map((n) => n.accountId).sort()).toEqual(
      [s.alice.id, s.tenant.id].sort(),
    );
  });

  it('an ended occupancy keeps its own documents until 90 days after the handover', async () => {
    const s = await home('Vault Retention Court');
    await file(s.tenant, s.home.id, {
      title: 'tenant-private',
      visibility: 'private',
    }).then(statusIs(201));
    const occupancy = await x.asManager(s.c, () =>
      x.prisma.tenant.unitOccupancy.findFirstOrThrow({
        where: { unitId: s.home.id, accountId: s.tenant.id, status: 'active' },
      }),
    );
    await x.asManager(s.c, () =>
      x.residents.endOccupancy(occupancy.id, {
        code: 'moved_out',
        text: 'Moved',
      }),
    );
    expect(await titles(s.tenant, s.home.id)).toEqual(['tenant-private']);
    await sweep.run(UNIT_DOCUMENT_RETENTION_SWEEP, daysLater(89));
    expect(await titles(s.tenant, s.home.id)).toEqual(['tenant-private']);
    await sweep.run(UNIT_DOCUMENT_RETENTION_SWEEP, daysLater(91));
    expect(await titles(s.tenant, s.home.id)).toEqual([]);
  });

  it('erasure deletes the account’s documents at once', async () => {
    const s = await home('Vault Erasure Court');
    await file(s.tenant, s.home.id, {
      title: 'tenant-shared',
      visibility: 'occupants',
    }).then(statusIs(201));
    await eraseNow(h, s.c, s.tenant.id);
    expect(await titles(s.alice, s.home.id)).toEqual([]);
  });
});

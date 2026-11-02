import { auditReaders } from '../setup/audit';
import { communityHelpers } from '../setup/community';
import { day } from '../setup/compound-clock';
import { nationalIdFor } from '../setup/fixtures';
import { queuedBehind } from '../setup/held-lock';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { securityHelpers, type Who } from '../setup/security';

interface EntryBody {
  id: string;
  reference: string;
  status: string;
  reasonCode: string;
  outcome: string | null;
  reportNote: string | null;
  witnessCount: number;
  photos: { stage: string; url: string }[];
  recordedByName?: string | null;
  witnessNames?: (string | null)[];
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: { field: string; code: string }[] }).fields;

/**
 * ADR 0083: an emergency entry into a unit is never silent — its people are
 * told as it is recorded, and again when it is reported, once — and the
 * management ends an owner's proxy with a code, the holder and the owner
 * told.
 */
describe('Emergency entries and the management’s end of a proxy', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let community: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    community = communityHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post',
    path: string,
    who: Who | null,
    body?: object,
  ) => {
    const req = h.http()[method](`${API}${path}`);
    return (who ? req.set('Authorization', `Bearer ${who.token}`) : req).send(
      body,
    );
  };
  type SetUp = Awaited<ReturnType<typeof x.setUp>>;

  /** An owner appoints a proxy, who accepts: its id and its account. */
  async function proxyOf(s: SetUp, scopes: string[]) {
    const email = uniqueEmail('m211-proxy');
    const res = await http('post', `/units/${s.home.id}/proxies`, s.alice, {
      fullName: 'Nadia Wakil',
      email,
      phone: uniquePhone(),
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(),
      scopes,
      endsOn: day(60),
    }).expect(201);
    const created = res.body as { proxy: { id: string }; token: string };
    const since = new Date();
    await http('post', '/proxy-invites/accept/start', null, {
      token: created.token,
    }).expect(202);
    const otp = await waitForOtp(email, since);
    await http('post', '/proxy-invites/accept/complete', null, {
      token: created.token,
      code: otp,
    }).expect(200);
    const account = await community.asManager(s.c, () =>
      community.prisma.tenant.account.findFirstOrThrow({
        where: { type: 'proxy', email },
      }),
    );
    const who: Who = {
      id: account.id,
      token: await h.tokenFor({
        sub: account.id,
        tid: s.c.tenantId,
        typ: 'proxy',
      }),
    };
    return { id: created.proxy.id, who };
  }

  async function setUp(name: string) {
    const s = await x.setUp(name);
    const supervisor = await x.supervisor(s.c);
    const witness = await x.guard(s.c);
    return { ...s, supervisor, witness };
  }
  const record = (s: Awaited<ReturnType<typeof setUp>>, over: object = {}) =>
    x.http('post', '/staff/security/unit-entries', s.supervisor.token, {
      unitId: s.home.id,
      reasonCode: 'water_leak',
      enteredAt: new Date().toISOString(),
      witnessIds: [s.witness.id],
      ...over,
    });
  const report = async (
    s: Awaited<ReturnType<typeof setUp>>,
    id: string,
    over: object = {},
  ) =>
    x.http(
      'post',
      `/staff/security/unit-entries/${id}/report`,
      s.supervisor.token,
      {
        outcome: 'contained',
        note: 'Closed the main valve; the kitchen floor is wet.',
        photoFileIds: [
          await x.files.ready(s.supervisor.token, 'unit_entry_photo'),
        ],
        ...over,
      },
    );

  it('recorded with a witness and a photo before: the unit’s people and its proxy for inspections are told at once; reported once', async () => {
    const s = await setUp('Entry Court');
    const tenant = await x.tenant(s.c, s.home.id);
    const proxy = await proxyOf(s, ['inspections']);
    const before = await x.files.ready(s.supervisor.token, 'unit_entry_photo');
    const res = await record(s, { photoFileIds: [before] }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const entry = res.body as EntryBody;
    expect(entry).toMatchObject({
      status: 'open',
      reasonCode: 'water_leak',
      witnessCount: 1,
      reference: expect.stringMatching(/^UE-\d{6}$/) as string,
      photos: [expect.objectContaining({ stage: 'before' })],
    });
    for (const who of [s.alice, tenant, proxy.who])
      expect(
        (await x.notifications(s.c, who.id, 'unit_entry.recorded')).map((n) => [
          n.targetId,
          n.params,
        ]),
      ).toEqual([
        [entry.id, expect.objectContaining({ entryReason: 'water_leak' })],
      ]);
    const inbox = (
      await x
        .http('get', '/staff/inbox?type=unit_entry_report', s.supervisor.token)
        .expect(200)
    ).body as { data: { id: string; number: string }[] };
    expect(inbox.data).toContainEqual(
      expect.objectContaining({ id: entry.id, number: entry.reference }),
    );

    const done = await report(s, entry.id);
    expect(done.status).toBe(200);
    const reported = done.body as EntryBody;
    expect(reported).toMatchObject({
      status: 'reported',
      outcome: 'contained',
      photos: [
        expect.objectContaining({ stage: 'before' }),
        expect.objectContaining({ stage: 'after' }),
      ],
    });
    expect(code(await report(s, entry.id))).toEqual({
      status: 409,
      code: 'UNIT_ENTRY_REPORTED',
    });
    expect(
      (await x.notifications(s.c, s.alice.id, 'unit_entry.reported')).map(
        (n) => n.targetId,
      ),
    ).toEqual([entry.id]);

    // The unit's people read it, never the staff's names; nobody else does.
    const read = await http('get', `/units/${s.home.id}/entries`, s.alice);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const theirs = read.body as EntryBody[];
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).not.toHaveProperty('recordedByName');
    expect(theirs[0]).not.toHaveProperty('witnessNames');
    expect(theirs[0].reportNote).toBe(
      'Closed the main valve; the kitchen floor is wet.',
    );
    const elsewhere = await x.unit(s.c, 'C');
    const stranger = await x.owner(s.c, elsewhere.id);
    expect(
      code(await http('get', `/units/${s.home.id}/entries`, stranger)),
    ).toEqual({ status: 404, code: 'UNIT_NOT_FOUND' });

    const audit = auditReaders(h);
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'unit_entry.recorded',
        targetId: entry.id,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: {
          unitId: s.home.id,
          reasonCode: 'water_leak',
          witnesses: 1,
          photos: 1,
          told: 3,
        },
      }),
    ]);
  });

  it('two staff at least, within the last week, a reason from the list; the report needs its words and a photo after', async () => {
    const s = await setUp('Entry Rules Court');
    expect(fields(await record(s, { witnessIds: [] }))).toEqual([
      expect.objectContaining({ field: 'witnessIds', code: 'INVALID_VALUE' }),
    ]);
    expect(fields(await record(s, { witnessIds: [s.supervisor.id] }))).toEqual([
      expect.objectContaining({ field: 'witnessIds', code: 'INVALID_VALUE' }),
    ]);
    // A resident is no witness.
    expect(fields(await record(s, { witnessIds: [s.alice.id] }))).toEqual([
      expect.objectContaining({ field: 'witnessIds', code: 'INVALID_VALUE' }),
    ]);
    expect(
      fields(
        await record(s, {
          enteredAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    ).toEqual([
      expect.objectContaining({ field: 'enteredAt', code: 'INVALID_VALUE' }),
    ]);
    expect(code(await record(s, { reasonCode: 'curiosity' }))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const entry = (await record(s).expect(201)).body as EntryBody;
    expect(fields(await report(s, entry.id, { photoFileIds: [] }))).toEqual([
      expect.objectContaining({
        field: 'photoFileIds',
        code: 'INVALID_LENGTH',
      }),
    ]);
    expect(fields(await report(s, entry.id, { note: ' ' }))).toEqual([
      expect.objectContaining({ field: 'note', code: 'INVALID_LENGTH' }),
    ]);
    // Only for guard_tasks.manage.
    expect(
      (
        await x.http('post', '/staff/security/unit-entries', s.witness.token, {
          unitId: s.home.id,
          reasonCode: 'fire',
          enteredAt: new Date().toISOString(),
          witnessIds: [s.supervisor.id],
        })
      ).status,
    ).toBe(403);
  });

  it('race: two reports at once — one is written, the other refused', async () => {
    const s = await setUp('Entry Race Court');
    const entry = (await record(s).expect(201)).body as EntryBody;
    const photos = [
      await x.files.ready(s.supervisor.token, 'unit_entry_photo'),
      await x.files.ready(s.supervisor.token, 'unit_entry_photo'),
    ];
    const answers = await queuedBehind(
      {
        sql: 'SELECT id FROM unit_entries WHERE id = $1 FOR UPDATE',
        params: [entry.id],
      },
      photos.map(
        (p) => () =>
          x.http(
            'post',
            `/staff/security/unit-entries/${entry.id}/report`,
            s.supervisor.token,
            { outcome: 'resolved', note: 'Done.', photoFileIds: [p] },
          ),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
  });

  it('the management ends a proxy with a code: the proxy’s holder and the owner who appointed it are told', async () => {
    const s = await setUp('Proxy Revoke Court');
    const proxy = await proxyOf(s, ['inspections', 'tickets']);
    const revoke = (body: object) =>
      x.http(
        'post',
        `/staff/units/${s.home.id}/proxies/${proxy.id}/revoke`,
        s.manager.token,
        body,
      );
    expect(code(await revoke({}))).toEqual({
      status: 400,
      code: 'REASON_REQUIRED',
    });
    const ended = (await revoke({ reasonCode: 'misuse' }).expect(200)).body as {
      status: string;
      endReason: string;
      revokeCode: string;
    };
    expect(ended).toMatchObject({
      status: 'ended',
      endReason: 'revoked',
      revokeCode: 'misuse',
    });
    for (const who of [s.alice, proxy.who])
      expect(
        (
          await x.notifications(s.c, who.id, 'unit_proxy.revoked_by_management')
        ).map((n) => n.params),
      ).toEqual([expect.objectContaining({ reason: 'misuse' })]);
    expect(code(await revoke({ reasonCode: 'misuse' }))).toEqual({
      status: 404,
      code: 'PROXY_NOT_FOUND',
    });
    // An owner's own revocation carries no code.
    const other = await proxyOf(s, ['tickets']);
    const own = (
      await http(
        'post',
        `/units/${s.home.id}/proxies/${other.id}/revoke`,
        s.alice,
      ).expect(200)
    ).body as { revokeCode: string | null };
    expect(own.revokeCode).toBeNull();
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'unit_proxy.revoked',
        targetId: proxy.id,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          side: 'management',
          revokeCode: 'misuse',
        }) as unknown,
      }),
    ]);
  });
});

import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { permitRow } from '../setup/permits-rows';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

interface ViolationBody {
  id: string;
  reference: string;
  kind: string;
  status: string;
  amount: string | null;
  isWarning?: boolean;
  permitReference?: string | null;
  unitCode?: string;
  canAppeal?: boolean;
  appeal?: { reason: string | null; decision: string | null } | null;
  cancelReason?: string | null;
}

const DAY = 86_400_000;

/**
 * ADR 0053: violations, as the fines (ADR 0045). A guard on shift or the
 * office issues one to a unit (contractor hours by its works permit), with
 * an amount or none (a warning); the unit's keepers and its primary are
 * told by the kind alone. A keeper or the primary appeals once within 30
 * days; `violations.manage` decides, and cancels an open one.
 */
describe('Violations', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let supervisor: Who;
  let placeId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Violations Court');
    guard = await x.guardOnDuty(s.c);
    supervisor = await x.supervisor(s.c);
    placeId = (await x.places(s.alice)).parking.id;
  }, 120_000);

  afterAll(() => h.close());

  const issueRaw = (
    as: Who,
    body: Record<string, unknown> = {},
    path = '/gate/violations',
  ) =>
    x.http('post', path, as.token, {
      kind: 'noise',
      unitCode: s.home.code,
      occurredOn: day(0),
      ...body,
    });
  const issue = async (body: Record<string, unknown> = {}) => {
    const res = await issueRaw(s.manager, body, '/staff/violations');
    if (res.status !== 201)
      throw new Error(`issue: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ViolationBody;
  };
  const appealRaw = (as: Who, id: string, body: Record<string, unknown> = {}) =>
    x.http('post', `/violations/${id}/appeal`, as.token, {
      reason: 'We were away that night',
      ...body,
    });
  const staffPost = (as: Who, id: string, path: string, body: object) =>
    x.http('post', `/staff/violations/${id}/${path}`, as.token, body);

  it('a guard issues a warning at a place: the unit’s people told by the kind alone; the unit reads it, never who issued it; audited by ids and codes', async () => {
    const res = await issueRaw(guard, {
      placeId,
      note: 'Music after midnight',
    }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const v = res.body as ViolationBody;
    expect(v).toMatchObject({
      kind: 'noise',
      unitCode: s.home.code,
      amount: null,
      status: 'open',
    });
    expect(v.reference).toMatch(/^V-\d{4}$/);
    expect(await x.told(s.c, s.alice.id, v.id)).toEqual([
      { kind: 'violation.issued', params: { violationKind: 'noise' } },
    ]);
    const mine = await x
      .http('get', `/violations/${v.id}`, s.alice.token)
      .expect(200);
    expect(mine.body).toMatchObject({
      isWarning: true,
      amount: null,
      note: 'Music after midnight',
      place: { id: placeId },
      canAppeal: true,
    });
    expect(leakText(mine.body)).not.toContain(guard.id);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'violation.issued',
      targetId: v.id,
    });
    expect(row).toMatchObject({
      actorId: guard.id,
      targetType: 'unit_violation',
    });
    expect(row.metadata).toEqual({
      unitId: s.home.id,
      permitId: null,
      placeId,
      number: expect.any(Number) as number,
      kind: 'noise',
      amount: null,
      currency: null,
      occurredOn: day(0),
      shiftId: guard.shiftId,
      photo: false,
      note: true,
    });
    expect(leakText(row)).not.toContain('Music');
    const staff = await x
      .http('get', `/staff/violations/${v.id}`, s.manager.token)
      .expect(200);
    expect(staff.body).toMatchObject({
      issuedBy: { id: guard.id },
      post: { gateId: guard.gateId },
    });
  });

  it('the office issues one with an amount and a photo; contractor hours by a works permit', async () => {
    const fined = await issue({
      kind: 'waste',
      amount: '250',
      photoFileId: await x.photo(s.manager, 'violation_photo'),
    });
    expect(fined).toMatchObject({ amount: '250.00', isWarning: false });
    const permitId = await x.inTx(s.c, (tx) =>
      permitRow(tx, {
        tenantId: s.c.tenantId,
        unitId: s.home.id,
        requestedById: s.alice.id,
      }),
    );
    const hours = await issue({
      kind: 'contractor_hours',
      unitCode: undefined,
      permitId,
    });
    expect(hours).toMatchObject({
      unitCode: s.home.code,
      permitReference: expect.stringMatching(/^W-\d{4,}$/) as string,
    });
    const fields = async (body: Record<string, unknown>) =>
      (
        (await issueRaw(s.manager, body, '/staff/violations').expect(400))
          .body as { fields: { field: string; code: string }[] }
      ).fields.map((f) => [f.field, f.code]);
    expect(await fields({ kind: 'pets', permitId })).toEqual([
      ['permitId', 'FIELD_NOT_ALLOWED'],
    ]);
    const other = await x.unit(s.c, 'B8');
    expect(
      await fields({
        kind: 'contractor_hours',
        unitCode: other.code,
        permitId,
      }),
    ).toEqual([['unitCode', 'UNIT_CODE_UNKNOWN']]);
    expect(await fields({ occurredOn: day(-91) })).toEqual([
      ['occurredOn', 'DAY_OUT_OF_RANGE'],
    ]);
    expect(await fields({ unitCode: undefined })).toEqual([
      ['unitCode', 'FIELD_REQUIRED'],
    ]);
    await issueRaw(s.manager, { amount: '0' }, '/staff/violations').expect(400);
  });

  it('who issues: a guard on shift and the office; never off shift, a supervisor at the office, or a resident', async () => {
    const offShift = await x.guard(s.c);
    await issueRaw(offShift)
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'NO_OPEN_SHIFT' }));
    await issueRaw(supervisor, {}, '/staff/violations').expect(403);
    await issueRaw(s.alice).expect(403);
    await issueRaw(s.alice, {}, '/staff/violations').expect(403);
  });

  it('one appeal within 30 days: upheld, then open again; accepted, cancelled; the appellant told each time', async () => {
    const upheld = await issue({ amount: '100' });
    await appealRaw(s.alice, upheld.id)
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'under_appeal',
          appeal: { reason: 'We were away that night', decision: null },
          canAppeal: false,
        }),
      );
    await appealRaw(s.alice, upheld.id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'VIOLATION_APPEAL_CLOSED' }),
      );
    await staffPost(supervisor, upheld.id, 'decide-appeal', {
      decision: 'upheld',
    })
      .expect(200)
      .expect((r) => expect(r.body).toMatchObject({ status: 'open' }));
    const accepted = await issue();
    await appealRaw(s.alice, accepted.id).expect(200);
    await staffPost(s.manager, accepted.id, 'decide-appeal', {
      decision: 'cancelled',
    })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'cancelled',
          cancelReason: 'appeal_accepted',
        }),
      );
    expect(
      (await x.told(s.c, s.alice.id, upheld.id)).map((t) => t.kind),
    ).toContain('violation.appeal_upheld');
    expect(
      (await x.told(s.c, s.alice.id, accepted.id)).map((t) => t.kind),
    ).toContain('violation.appeal_accepted');
    await staffPost(s.manager, upheld.id, 'decide-appeal', {
      decision: 'upheld',
    })
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'VIOLATION_NOT_UNDER_APPEAL' }),
      );
    await staffPost(guard, upheld.id, 'decide-appeal', {
      decision: 'upheld',
    }).expect(403);
  });

  it('an appeal after 30 days is late', async () => {
    const id = newId();
    await x.inTx(s.c, (tx) =>
      tx.unitViolation.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          number: 990_001,
          kind: 'pets',
          unitId: s.home.id,
          occurredOn: new Date(Date.now() - 40 * DAY),
          issuedById: s.manager.id,
          createdAt: new Date(Date.now() - 31 * DAY),
        },
      }),
    );
    await appealRaw(s.alice, id)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'VIOLATION_APPEAL_WINDOW_PASSED',
          params: { days: 30 },
        }),
      );
  });

  it('the management cancels an open violation, never one under appeal; the unit’s list; who sees it', async () => {
    const open = await issue();
    await staffPost(supervisor, open.id, 'cancel', { reasonCode: 'duplicate' })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'cancelled',
          cancelReason: 'duplicate',
        }),
      );
    await staffPost(supervisor, open.id, 'cancel', { reasonCode: 'other' })
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'VIOLATION_NOT_CANCELLABLE' }),
      );
    const appealed = await issue();
    await appealRaw(s.alice, appealed.id).expect(200);
    await staffPost(s.manager, appealed.id, 'cancel', {
      reasonCode: 'other',
    }).expect(409);
    const list = (
      await x
        .http(
          'get',
          `/units/${s.home.id}/violations?status=cancelled`,
          s.alice.token,
        )
        .expect(200)
    ).body as { data: ViolationBody[] };
    expect(list.data.map((v) => v.id)).toContain(open.id);
    const stranger = await x.owner(s.c, (await x.unit(s.c, 'B9')).id);
    await x
      .http('get', `/violations/${open.id}`, stranger.token)
      .expect(404)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'VIOLATION_NOT_FOUND' }),
      );
    await x
      .http('get', `/units/${s.home.id}/violations`, stranger.token)
      .expect(404);
    await x.http('get', '/staff/violations', guard.token).expect(403);
  });
});

import { IdentifierHasher } from '../../src/core/auth/identifier';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import {
  childrenHelpers,
  type EscortBody,
  type PickupBody,
  type Who,
} from '../setup/children';
import { day, today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;
const fieldsOf = (res: { body: unknown }) =>
  (res.body as { fields: unknown }).fields;

/**
 * ADR 0054: who may collect a child — an adult who lives in the unit, one
 * of its domestic workers, or an outside person with a personal pickup
 * code (QR, 6 digits, a link with the token in the fragment) — each with
 * days, hours and a post. The primary or a household delegate manages them;
 * the household adults read them; the outside person's page names nobody.
 */
describe('Children — escorts', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;
  let hasher: IdentifierHasher;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    audit = auditReaders(h);
    hasher = h.moduleRef.get(IdentifierHasher);
    s = await x.setUp('Escorts Court');
  }, 120_000);

  afterAll(() => h.close());

  const escortRow = (id: string) =>
    x.inTx(s.c, (tx) => tx.childEscort.findUniqueOrThrow({ where: { id } }));

  it('an adult of the household: no code; once per child; a landlord or someone of another unit is not eligible', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const member = await x.family(s.c, home.id, primary);
    const escort = await x.addEscort(primary, home.id, memberId, {
      kind: 'adult',
      accountId: member.id,
    });
    expect(escort).toMatchObject({
      kind: 'adult',
      accountId: member.id,
      phone: null,
      photoUrl: null,
      validFrom: today(),
      validUntil: null,
      schedule: null,
      post: null,
      pickup: null,
    });
    expect(escort.name).toEqual(expect.any(String));
    expect(
      codeOf(
        await x
          .addEscortRaw(primary, home.id, memberId, {
            kind: 'adult',
            accountId: member.id,
          })
          .expect(409),
      ),
    ).toBe('CHILD_ESCORT_DUPLICATE');

    const landlord = await x.landlord(s.c, home.id);
    const stranger = await x.owner(s.c, (await x.unit(s.c)).id);
    for (const who of [landlord, stranger])
      expect(
        fieldsOf(
          await x
            .addEscortRaw(primary, home.id, memberId, {
              kind: 'adult',
              accountId: who.id,
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'accountId', code: 'ESCORT_NOT_ELIGIBLE' }]);

    // The household adults read them.
    expect(
      (await x.escorts(member, home.id, memberId)).map((e) => e.id),
    ).toEqual([escort.id]);
    expect((await x.children(primary, home.id))[0].control?.escorts).toBe(1);
  });

  it("one of the unit's domestic workers, while the engagement works", async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const nanny = await x.worker(s.c, primary, home.id);
    const escort = await x.addEscort(primary, home.id, memberId, {
      kind: 'worker',
      engagementId: nanny.engagementId,
    });
    expect(escort).toMatchObject({
      kind: 'worker',
      engagementId: nanny.engagementId,
      name: nanny.fullName,
      pickup: null,
    });
    const elsewhere = await x.unit(s.c);
    const theirs = await x.worker(
      s.c,
      await x.owner(s.c, elsewhere.id),
      elsewhere.id,
    );
    expect(
      fieldsOf(
        await x
          .addEscortRaw(primary, home.id, memberId, {
            kind: 'worker',
            engagementId: theirs.engagementId,
          })
          .expect(400),
      ),
    ).toEqual([{ field: 'engagementId', code: 'ESCORT_NOT_ELIGIBLE' }]);
  });

  it('an outside person: the code, the QR and the link once; only their HMACs and the link pointer kept', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const res = await x
      .addEscortRaw(primary, home.id, memberId, {
        ...x.outside('Mona Adel'),
        validUntil: day(30),
        schedule: {
          days: [0, 1, 2, 3, 4],
          windows: [{ from: '13:00', to: '16:00' }],
        },
      })
      .expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const escort = res.body as EscortBody & { pickup: PickupBody };
    expect(escort.pickup.code).toMatch(/^\d{6}$/);
    expect(escort.pickup.qrPayload).toMatch(/^JWP1\.[A-Za-z0-9_-]{43}$/);
    const token = x.tokenOf(escort.pickup);
    expect(escort.pickup.link).toMatch(/\/c#[A-Za-z0-9_-]{43}$/);
    expect(escort.pickup.qrPayload).toBe(`JWP1.${token}`);
    expect(escort).toMatchObject({
      name: 'Mona Adel',
      validUntil: day(30),
      schedule: {
        days: [0, 1, 2, 3, 4],
        windows: [{ from: '13:00', to: '16:00' }],
      },
    });

    const row = await escortRow(escort.id);
    expect(row.pickupCodeHash).toBe(
      hasher.hashChildPickupCode(s.c.tenantId, escort.pickup.code),
    );
    expect(row.pickupQrHash).toBe(
      hasher.hashChildPickupQr(s.c.tenantId, token),
    );
    expect(JSON.stringify(row)).not.toContain(token);
    const link = await h.moduleRef
      .get(GlobalDbService)
      .childPickupLink.findUnique({
        where: { tokenHash: hasher.hashChildPickupLink(token) },
      });
    expect(link).toMatchObject({ tenantId: s.c.tenantId, escortId: escort.id });

    // The list never carries the code.
    const listed = JSON.stringify(await x.escorts(primary, home.id, memberId));
    expect(listed).not.toContain(token);
    expect(listed).not.toContain(`"code":"${escort.pickup.code}"`);

    // Audit: who and when by value; the person as changed.
    const [added] = await audit.tenant(s.c.tenantId, {
      action: 'child_escort.added',
      targetId: escort.id,
    });
    expect(added.changes).toMatchObject({
      kind: { from: null, to: 'outside' },
      fullName: { changed: true },
      phone: { changed: true },
      validUntil: { from: null, to: day(30) },
    });
    expect(JSON.stringify(added)).not.toMatch(/Mona Adel|\+20/);
  });

  it("the outside person's page: the compound, the unit, when and where, the code while it works; never a name", async () => {
    const { home, primary, memberId } = await x.controlled(s.c, undefined, {
      fullName: 'Hidden Childname Here',
    });
    const escort = await x.addEscort(primary, home.id, memberId, {
      ...x.outside('Hidden Escortname Here'),
      validFrom: day(1),
    });
    const token = x.tokenOf(escort.pickup!);
    const page = await x.pickupPage(token).expect(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toMatchObject({
      unitCode: home.code,
      validFrom: day(1),
      status: 'not_yet',
      code: null,
      qrPayload: null,
    });
    for (const secret of [
      'Hidden Childname',
      'Hidden Escortname',
      primary.id,
      memberId,
    ])
      expect(page.text).not.toContain(secret);

    const now = await x.addEscort(primary, home.id, memberId, x.outside());
    const live = await x.pickupPage(x.tokenOf(now.pickup!)).expect(200);
    expect(live.body).toMatchObject({
      status: 'active',
      code: now.pickup!.code,
      qrPayload: now.pickup!.qrPayload,
    });

    // One 404 for anything that is not a live link.
    for (const bad of ['x', 'A'.repeat(43), now.pickup!.qrPayload])
      expect(codeOf(await x.pickupPage(bad).expect(404))).toBe(
        'CHILD_PICKUP_NOT_FOUND',
      );
  });

  it('reissue: a new code, QR and link once; the old link answers 404 at once', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const escort = await x.addEscort(primary, home.id, memberId, x.outside());
    const path = `${x.escortsPath(home.id, memberId)}/${escort.id}/reissue`;
    const res = await x.http('post', path, primary.token).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const fresh = (res.body as { pickup: PickupBody }).pickup;
    expect(fresh.link).not.toBe(escort.pickup!.link);
    await x.pickupPage(x.tokenOf(escort.pickup!)).expect(404);
    await x.pickupPage(x.tokenOf(fresh)).expect(200);
    const adult = await x.addEscort(primary, home.id, memberId, {
      kind: 'adult',
      accountId: (await x.family(s.c, home.id, primary)).id,
    });
    expect(
      codeOf(
        await x
          .http(
            'post',
            `${x.escortsPath(home.id, memberId)}/${adult.id}/reissue`,
            primary.token,
          )
          .expect(404),
      ),
    ).toBe('CHILD_ESCORT_NOT_FOUND');
  });

  it('revoke: the link dies, the photo is deleted, the name stays for now; turning control off revokes the rest', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const photo = await x.files.ready(primary.token, 'child_escort_photo');
    const withPhoto = await x.addEscort(primary, home.id, memberId, {
      ...x.outside('Photo Person'),
      outside: { ...x.outside().outside, photoFileId: photo },
    });
    expect(withPhoto.photoUrl).toEqual(expect.any(String));
    const other = await x.addEscort(primary, home.id, memberId, x.outside());
    const base = x.escortsPath(home.id, memberId);
    await x
      .http('post', `${base}/${withPhoto.id}/revoke`, primary.token)
      .expect(204);
    const row = await escortRow(withPhoto.id);
    expect(row).toMatchObject({
      revokeReason: 'household',
      revokedById: primary.id,
      pickupCodeHash: null,
      pickupQrHash: null,
      photoFileId: null,
    });
    expect(row.fullName).not.toBeNull();
    await x.pickupPage(x.tokenOf(withPhoto.pickup!)).expect(404);
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findMany({ where: { id: photo, deletedAt: null } }),
    );
    expect(file).toEqual([]);
    expect(
      codeOf(
        await x
          .http('post', `${base}/${withPhoto.id}/revoke`, primary.token)
          .expect(404),
      ),
    ).toBe('CHILD_ESCORT_NOT_FOUND');

    await x
      .http('post', `${x.controlPath(home.id, memberId)}/off`, primary.token)
      .expect(204);
    expect((await escortRow(other.id)).revokeReason).toBe('control_off');
    await x.pickupPage(x.tokenOf(other.pickup!)).expect(404);
  });

  it('validity: today or later, an end after the start, a real schedule and a post in service; changed by PATCH', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const bad = async (body: Record<string, unknown>) =>
      fieldsOf(
        await x
          .addEscortRaw(primary, home.id, memberId, { ...x.outside(), ...body })
          .expect(400),
      );
    expect(await bad({ validFrom: day(-1) })).toEqual([
      {
        field: 'validFrom',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: today() },
      },
    ]);
    expect(await bad({ validFrom: day(3), validUntil: day(2) })).toEqual([
      { field: 'validUntil', code: 'ENDS_BEFORE_START' },
    ]);
    expect(
      await bad({ post: { gateId: '01a102b6-6253-74a0-92b1-96e7c9d52601' } }),
    ).toEqual([{ field: 'gateId', code: 'POST_NOT_AVAILABLE' }]);
    expect(
      fieldsOf(
        await x
          .addEscortRaw(primary, home.id, memberId, { kind: 'outside' })
          .expect(400),
      ),
    ).toEqual([{ field: 'outside', code: 'FIELD_REQUIRED' }]);
    expect(
      fieldsOf(
        await x
          .addEscortRaw(primary, home.id, memberId, {
            ...x.outside(),
            accountId: primary.id,
          })
          .expect(400),
      ),
    ).toEqual([{ field: 'accountId', code: 'FIELD_NOT_ALLOWED' }]);

    const gate = await x.g.gate(s.c);
    const escort = await x.addEscort(primary, home.id, memberId, {
      ...x.outside(),
      post: { gateId: gate.id },
    });
    expect(escort.post?.gateId).toBe(gate.id);
    const changed = await x
      .http(
        'patch',
        `${x.escortsPath(home.id, memberId)}/${escort.id}`,
        primary.token,
        { validUntil: day(7), post: null },
      )
      .expect(200);
    expect(changed.body).toMatchObject({ validUntil: day(7), post: null });
    const [updated] = await audit.tenant(s.c.tenantId, {
      action: 'child_escort.updated',
      targetId: escort.id,
    });
    expect(updated.changes).toEqual({
      validUntil: { from: null, to: day(7) },
      gateId: { from: gate.id, to: null },
    });
  });

  it('ten live escorts per child at most', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    for (let i = 0; i < 10; i++)
      await x.addEscort(primary, home.id, memberId, x.outside(`Person ${i}`));
    const res = await x
      .addEscortRaw(primary, home.id, memberId, x.outside())
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'CHILD_ESCORT_LIMIT_REACHED',
      params: { max: 10 },
    });
  });

  it('who may: the primary changes them; a member reads but does not change; another unit is not found', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const member: Who = await x.family(s.c, home.id, primary);
    expect(
      codeOf(
        await x
          .addEscortRaw(member, home.id, memberId, x.outside())
          .expect(403),
      ),
    ).toBe('NOT_PRIMARY_RESIDENT');
    expect(await x.escorts(member, home.id, memberId)).toEqual([]);
    const stranger = await x.owner(s.c, (await x.unit(s.c)).id);
    expect(
      codeOf(
        await x
          .http('get', x.escortsPath(home.id, memberId), stranger.token)
          .expect(404),
      ),
    ).toBe('UNIT_NOT_FOUND');
  });
});

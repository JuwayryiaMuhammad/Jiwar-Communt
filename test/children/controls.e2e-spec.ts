import { createHash } from 'node:crypto';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { at, day } from '../setup/compound-clock';
import {
  childrenHelpers,
  type ChildCardBody,
  type ChildControlBody,
  type Who,
} from '../setup/children';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0054: a child's exit control, the household's side. The primary or a
 * household delegate turns it on for one of the unit's minors (the card
 * once), sets the switches and the photo, reissues the card and turns it
 * off; the household adults read it; nobody else does.
 */
const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;
const fieldsOf = (res: { body: unknown }) =>
  (res.body as { fields: unknown }).fields;

describe('Children — exit control', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    audit = auditReaders(h);
    s = await x.setUp('Controls Court');
  }, 120_000);

  afterAll(() => h.close());

  const hashOf = (card: ChildCardBody) =>
    createHash('sha256')
      .update(
        `jiwar:child-card:v1:${s.c.tenantId}:${card.qrPayload.slice('JWC1.'.length)}`,
      )
      .digest('hex');

  async function home() {
    const unit = await x.unit(s.c, 'C');
    const primary = await x.owner(s.c, unit.id);
    const memberId = await x.minor(primary, unit.id, {
      fullName: 'Omar Hany Saleh',
    });
    return { unit, primary, memberId };
  }

  it('turns on: the card once (no-store), only its SHA-256 kept, the list shows the control without it', async () => {
    const { unit, primary, memberId } = await home();
    const res = await x
      .turnOnRaw(primary, unit.id, memberId, {
        mayLeaveAlone: false,
        notifyPickups: true,
      })
      .expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as ChildControlBody & { card: ChildCardBody };
    expect(body.card.qrPayload).toMatch(/^JWC1\.[A-Za-z0-9_-]{43}$/);
    expect(body.card.firstName).toBe('Omar');
    expect(body.card.unitCode).toBe(unit.code);
    expect(body.mayLeaveAlone).toBe(false);
    expect(body.notifyPickups).toBe(true);
    expect(body.photoUrl).toBeNull();

    const row = await x.controlRow(s.c, body.id);
    expect(row.cardTokenHash).toBe(hashOf(body.card));
    expect(row.memberIsMinor).toBe(true);

    const [child] = await x.children(primary, unit.id);
    expect(child).toEqual({
      memberId,
      firstName: 'Omar',
      fullName: 'Omar Hany Saleh',
      age: 8,
      control: {
        id: body.id,
        mayLeaveAlone: false,
        notifyPickups: true,
        cardIssuedAt: body.cardIssuedAt,
        photoUrl: null,
        turnedOnAt: body.turnedOnAt,
        escorts: 0,
      },
    });
    expect(JSON.stringify(child)).not.toContain(body.card.qrPayload);

    const [entry] = await audit.tenant(s.c.tenantId, {
      action: 'child_control.turned_on',
      targetId: body.id,
    });
    expect(entry.metadata).toEqual({
      unitId: unit.id,
      memberId,
      mayLeaveAlone: false,
      notifyPickups: true,
    });
  });

  it('one live control per child; an adult member and an unknown id are not a child', async () => {
    const { unit, primary, memberId } = await home();
    await x.turnOn(primary, unit.id, memberId);
    const again = await x.turnOnRaw(primary, unit.id, memberId).expect(409);
    expect(codeOf(again)).toBe('CHILD_CONTROL_ACTIVE');

    const adult = await x.family(s.c, unit.id, primary);
    expect(
      codeOf(await x.turnOnRaw(primary, unit.id, adult.memberId).expect(404)),
    ).toBe('CHILD_NOT_FOUND');
    expect(
      codeOf(await x.turnOnRaw(primary, unit.id, newId()).expect(404)),
    ).toBe('CHILD_NOT_FOUND');
  });

  it('who may: the primary and a household delegate change it; a member, a landlord, another unit and a manager may not', async () => {
    const { unit, primary, memberId } = await home();
    const member = await x.family(s.c, unit.id, primary);
    const delegate = await x.family(s.c, unit.id, primary);
    await x.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(DelegationsService)
        .create(unit.id, delegate.id, ['household'], at(day(30), 12, 0)),
    );
    const landlord = await x.landlord(s.c, unit.id);
    const elsewhere = await x.owner(s.c, (await x.unit(s.c)).id);

    expect(
      codeOf(await x.turnOnRaw(member, unit.id, memberId).expect(403)),
    ).toBe('NOT_PRIMARY_RESIDENT');
    expect(
      codeOf(await x.turnOnRaw(landlord, unit.id, memberId).expect(403)),
    ).toBe('NOT_PRIMARY_RESIDENT');
    expect(
      codeOf(await x.turnOnRaw(elsewhere, unit.id, memberId).expect(404)),
    ).toBe('UNIT_NOT_FOUND');
    await x.turnOnRaw(s.manager, unit.id, memberId).expect(403);

    const byDelegate = await x
      .turnOnRaw(delegate, unit.id, memberId)
      .expect(201);
    const [entry] = await audit.tenant(s.c.tenantId, {
      action: 'child_control.turned_on',
      targetId: (byDelegate.body as { id: string }).id,
    });
    expect(entry.metadata).toMatchObject({ onBehalfOf: primary.id });

    // Reading: the household adults; never a landlord or another unit.
    expect(await x.children(member, unit.id)).toHaveLength(1);
    expect(
      codeOf(
        await x
          .http('get', `/units/${unit.id}/children`, landlord.token)
          .expect(403),
      ),
    ).toBe('NOT_A_RESIDENT');
    expect(
      codeOf(
        await x
          .http('get', `/units/${unit.id}/children`, elsewhere.token)
          .expect(404),
      ),
    ).toBe('UNIT_NOT_FOUND');
    await x
      .http('get', `/units/${unit.id}/children`, s.manager.token)
      .expect(403);
  });

  it('under a death review: turning on and letting a child leave alone wait; tightening and turning off never do', async () => {
    const { unit, primary, memberId } = await home();
    const other = await x.minor(primary, unit.id, { fullName: 'Lina Hany' });
    const control = await x.turnOn(primary, unit.id, memberId);
    await x.inTx(s.c, (tx) =>
      tx.unitReviewFlag.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          unitId: unit.id,
          reason: 'primary_deceased',
          reasonCode: 'deceased',
          flaggedById: s.c.managerId,
        },
      }),
    );
    expect(codeOf(await x.turnOnRaw(primary, unit.id, other).expect(403))).toBe(
      'HOUSEHOLD_UNDER_REVIEW',
    );
    const path = x.controlPath(unit.id, memberId);
    expect(
      codeOf(
        await x
          .http('patch', path, primary.token, { mayLeaveAlone: true })
          .expect(403),
      ),
    ).toBe('HOUSEHOLD_UNDER_REVIEW');
    await x
      .http('patch', path, primary.token, { notifyPickups: false })
      .expect(200);
    await x.http('post', `${path}/off`, primary.token).expect(204);
    expect((await x.controlRow(s.c, control.id)).endReason).toBe('household');
  });

  it('changes the switches, audited by value', async () => {
    const { unit, primary, memberId } = await home();
    const control = await x.turnOn(primary, unit.id, memberId);
    const res = await x
      .http('patch', x.controlPath(unit.id, memberId), primary.token, {
        mayLeaveAlone: true,
      })
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      mayLeaveAlone: true,
      notifyPickups: true,
    });
    const [entry] = await audit.tenant(s.c.tenantId, {
      action: 'child_control.updated',
      targetId: control.id,
    });
    expect(entry.changes).toEqual({
      mayLeaveAlone: { from: false, to: true },
    });
  });

  it('reissues the card: a new one once, the old hash gone; a replay of the key prints yet another', async () => {
    const { unit, primary, memberId } = await home();
    const control = await x.turnOn(primary, unit.id, memberId);
    const path = `${x.controlPath(unit.id, memberId)}/card`;
    const key = { 'Idempotency-Key': `card-${newId()}` };
    const first = await x
      .http('post', path, primary.token, {}, key)
      .expect(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const card = (first.body as { card: ChildCardBody }).card;
    expect(card.qrPayload).not.toBe(control.card.qrPayload);
    let row = await x.controlRow(s.c, control.id);
    expect(row.cardTokenHash).toBe(hashOf(card));

    const replay = await x
      .http('post', path, primary.token, {}, key)
      .expect(200);
    const again = (replay.body as { card: ChildCardBody }).card;
    expect(again.qrPayload).not.toBe(card.qrPayload);
    row = await x.controlRow(s.c, control.id);
    expect(row.cardTokenHash).toBe(hashOf(again));
    const idem = await x.inTx(s.c, (tx) =>
      tx.idempotencyKey.findMany({ where: { key: key['Idempotency-Key'] } }),
    );
    expect(JSON.stringify(idem)).not.toContain(again.qrPayload);
  });

  it("sets, replaces and removes the child's photo; only the caller's finalized child_photo", async () => {
    const { unit, primary, memberId } = await home();
    const control = await x.turnOn(primary, unit.id, memberId);
    const path = `${x.controlPath(unit.id, memberId)}/photo`;
    const first = await x.files.ready(primary.token, 'child_photo');
    await x.http('put', path, primary.token, { fileId: first }).expect(204);
    const [child] = await x.children(primary, unit.id);
    expect(child.control?.photoUrl).toEqual(expect.any(String));

    const second = await x.files.ready(primary.token, 'child_photo');
    await x.http('put', path, primary.token, { fileId: second }).expect(204);
    expect((await x.controlRow(s.c, control.id)).photoFileId).toBe(second);
    const old = await x.inTx(s.c, (tx) =>
      tx.storedFile.findMany({ where: { id: first, deletedAt: null } }),
    );
    expect(old).toEqual([]);

    const someoneElse = await x.owner(s.c, (await x.unit(s.c)).id);
    const theirs = await x.files.ready(someoneElse.token, 'child_photo');
    const wrong = await x
      .http('put', path, primary.token, { fileId: theirs })
      .expect(400);
    expect(fieldsOf(wrong)).toEqual([
      { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
    const worker = await x.files.ready(primary.token, 'gate_service_photo');
    await x.http('put', path, primary.token, { fileId: worker }).expect(400);

    await x.http('delete', path, primary.token).expect(204);
    await x.http('delete', path, primary.token).expect(204);
    expect((await x.controlRow(s.c, control.id)).photoFileId).toBeNull();
    const entries = await audit.tenant(s.c.tenantId, {
      action: 'child_control.photo_changed',
      targetId: control.id,
    });
    expect(entries).toHaveLength(3);
    for (const e of entries)
      expect(JSON.stringify(e)).not.toMatch(new RegExp(`${first}|${second}`));
  });

  it('turns off: the card and the photo go at once; the list shows no control; turning on again is a new period', async () => {
    const { unit, primary, memberId } = await home();
    const control = await x.turnOn(primary, unit.id, memberId);
    const path = x.controlPath(unit.id, memberId);
    const photo = await x.files.ready(primary.token, 'child_photo');
    await x
      .http('put', `${path}/photo`, primary.token, { fileId: photo })
      .expect(204);
    await x.http('post', `${path}/off`, primary.token).expect(204);
    const row = await x.controlRow(s.c, control.id);
    expect(row).toMatchObject({
      endReason: 'household',
      endedById: primary.id,
      cardTokenHash: null,
      photoFileId: null,
    });
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findMany({ where: { id: photo, deletedAt: null } }),
    );
    expect(file).toEqual([]);
    expect((await x.children(primary, unit.id))[0].control).toBeNull();
    expect(
      codeOf(await x.http('post', `${path}/off`, primary.token).expect(404)),
    ).toBe('CHILD_CONTROL_NOT_FOUND');
    expect(
      codeOf(await x.http('post', `${path}/card`, primary.token).expect(404)),
    ).toBe('CHILD_CONTROL_NOT_FOUND');

    const next = await x.turnOn(primary, unit.id, memberId);
    expect(next.id).not.toBe(control.id);
    const [ended] = await audit.tenant(s.c.tenantId, {
      action: 'child_control.ended',
      targetId: control.id,
    });
    expect(ended.metadata).toMatchObject({ reasonCode: 'household' });
  });

  it('a primary who is not of this household is refused by the unit, as for any unit they cannot see', async () => {
    const { unit, memberId } = await home();
    const stranger: Who = await x.owner(s.c, (await x.unit(s.c)).id);
    expect(
      codeOf(
        await x
          .http('patch', x.controlPath(unit.id, memberId), stranger.token, {
            notifyPickups: false,
          })
          .expect(404),
      ),
    ).toBe('UNIT_NOT_FOUND');
  });
});

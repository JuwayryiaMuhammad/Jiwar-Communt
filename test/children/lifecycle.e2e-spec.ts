import { HouseholdsService } from '../../src/community/households/households.service';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { CHILD_MAJORITY_SWEEP } from '../../src/gate/children/child-controls.service';
import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import { childrenHelpers } from '../setup/children';
import { at, day } from '../setup/compound-clock';
import { bornYearsAgo } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';

/**
 * ADR 0054: a child's exit control ends with the child's place in the
 * household — when the membership ends (a removal, the household's end),
 * when the same member row comes of age, and on the 18th birthday by the
 * compound's day — in that transaction, with the card and the photo.
 */
describe('Children — when a control ends by itself', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    audit = auditReaders(h);
    s = await x.setUp('Lifecycle Court');
  }, 120_000);

  afterAll(() => h.close());

  /** A controlled child with a photo. */
  async function withPhoto(opts: { daysTo18?: number } = {}) {
    const home = await x.unit(s.c, 'C');
    const primary = await x.owner(s.c, home.id);
    const memberId = await x.minor(primary, home.id, opts);
    const control = await x.turnOn(primary, home.id, memberId);
    const photo = await x.files.ready(primary.token, 'child_photo');
    await x
      .http('put', `${x.controlPath(home.id, memberId)}/photo`, primary.token, {
        fileId: photo,
      })
      .expect(204);
    return { home, primary, memberId, control, photo };
  }

  async function expectEnded(controlId: string, photo: string, reason: string) {
    const row = await x.controlRow(s.c, controlId);
    expect(row).toMatchObject({
      endReason: reason,
      endedById: null,
      cardTokenHash: null,
      photoFileId: null,
    });
    expect(row.endedAt).not.toBeNull();
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findMany({ where: { id: photo, deletedAt: null } }),
    );
    expect(file).toEqual([]);
    const [entry] = await audit.tenant(s.c.tenantId, {
      action: 'child_control.ended',
      targetId: controlId,
    });
    expect(entry.metadata).toMatchObject({ reasonCode: reason });
  }

  it('removing the child from the household ends it (left_household)', async () => {
    const { home, primary, memberId, control, photo } = await withPhoto();
    await x.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).removeMember(memberId, {
        code: 'moved_out',
        text: 'Moved away',
      }),
    );
    await expectEnded(control.id, photo, 'left_household');
    expect(await x.children(primary, home.id)).toEqual([]);
  });

  it("the household's end ends it too", async () => {
    const { home, control, photo } = await withPhoto();
    await x.x.asManager(s.c, () =>
      h.moduleRef.get(ResidentsService).endHousehold(home.id, {
        code: 'household_left',
        text: 'Left',
      }),
    );
    await expectEnded(control.id, photo, 'left_household');
  });

  it("the 18th birthday by the compound's day: not before; the sweep ends it after (came_of_age)", async () => {
    const { control, photo } = await withPhoto({ daysTo18: 2 });
    await x.sweep(CHILD_MAJORITY_SWEEP, at(day(1), 12, 0));
    expect((await x.controlRow(s.c, control.id)).endedAt).toBeNull();
    expect(
      await x.sweep(CHILD_MAJORITY_SWEEP, at(day(2), 0, 30)),
    ).toBeGreaterThanOrEqual(1);
    await expectEnded(control.id, photo, 'came_of_age');
    // Once.
    await x.sweep(CHILD_MAJORITY_SWEEP, at(day(3), 12, 0));
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'child_control.ended',
        targetId: control.id,
      }),
    ).toHaveLength(1);
  });

  it('the majority invite accepted before the sweep ran: the control ends first, and the member becomes an adult', async () => {
    const { home, primary, memberId, control, photo } = await withPhoto();
    // Of age today; the sweep has not run yet.
    await x.inTx(s.c, (tx) =>
      tx.householdMember.update({
        where: { id: memberId },
        data: { birthDate: bornYearsAgo(18) },
      }),
    );
    const email = uniqueEmail('adult');
    const invite = await x.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(HouseholdsService)
        .inviteMemberToAdulthood(memberId, { email, phone: uniquePhone() }),
    );
    const acceptance = h.moduleRef.get(InviteAcceptanceService);
    const since = new Date();
    await acceptance.startAcceptance(invite.token, '10.9.9.7', 'en');
    const accepted = await acceptance.completeAcceptance(
      invite.token,
      await waitForOtp(email, since),
    );
    expect(accepted).toMatchObject({ memberId, membershipStatus: 'active' });
    await expectEnded(control.id, photo, 'came_of_age');
    expect((await x.controlRow(s.c, control.id)).memberIsMinor).toBe(false);
    expect(await x.children(primary, home.id)).toEqual([]);
  });

  it('an adult escort who leaves the household, or whose account is erased, no longer collects the child (left_household)', async () => {
    const { home, primary, memberId } = await x.controlled(s.c);
    const leaving = await x.family(s.c, home.id, primary);
    const erased = await x.family(s.c, home.id, primary);
    const stays = await x.family(s.c, home.id, primary);
    const add = (accountId: string) =>
      x.addEscort(primary, home.id, memberId, { kind: 'adult', accountId });
    const [a, b, c] = [
      await add(leaving.id),
      await add(erased.id),
      await add(stays.id),
    ];
    await x.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).removeMember(leaving.memberId, {
        code: 'moved_out',
        text: 'Moved',
      }),
    );
    await eraseNow(h, s.c, erased.id);
    const rows = await x.inTx(s.c, (tx) =>
      tx.childEscort.findMany({
        where: { id: { in: [a.id, b.id, c.id] } },
        select: { id: true, revokeReason: true },
      }),
    );
    const reason = new Map(rows.map((r) => [r.id, r.revokeReason]));
    expect(reason.get(a.id)).toBe('left_household');
    expect(reason.get(b.id)).toBe('left_household');
    expect(reason.get(c.id)).toBeNull();
    expect(
      (await x.escorts(primary, home.id, memberId)).map((e) => e.id),
    ).toEqual([c.id]);
  });
});

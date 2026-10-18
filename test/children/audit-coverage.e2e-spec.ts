import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { HouseholdsService } from '../../src/community/households/households.service';
import * as split from '../setup/audit-coverage-split';
import { auditReaders } from '../setup/audit';
import { childrenHelpers, type Who } from '../setup/children';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per children catalog entry (ADR 0014, 0054): actor, target
 * and metadata — ids, codes, switches and counts by value; never a child's
 * name, a card, a hash or a file id.
 */
const covered = new Set<string>();

const CHILD_NAME = 'Audited Childname Sentinel';

describe('Audit coverage — children', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    s = await x.setUp('Children Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(
    action: string,
    targetId: string,
    secrets: string[] = [],
  ) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found)
      for (const secret of [CHILD_NAME, ...secrets])
        expect(JSON.stringify(row)).not.toContain(secret);
    return found;
  }
  async function single(action: string, targetId: string, secrets?: string[]) {
    const found = await rows(action, targetId, secrets);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who) => ({
    actorType: 'account',
    actorId: who.id,
    targetType: 'child_control',
  });

  it('a control turned on, changed, its card reissued, its photo set, turned off', async () => {
    const { home, primary, memberId, control } = await x.controlled(
      s.c,
      { mayLeaveAlone: false, notifyPickups: true },
      { fullName: CHILD_NAME },
    );
    const card = control.card.qrPayload;
    const on = await single('child_control.turned_on', control.id, [card]);
    expect(on).toMatchObject(by(primary));
    expect(on.metadata).toEqual({
      unitId: home.id,
      memberId,
      mayLeaveAlone: false,
      notifyPickups: true,
    });

    const path = x.controlPath(home.id, memberId);
    await x
      .http('patch', path, primary.token, { notifyPickups: false })
      .expect(200);
    const updated = await single('child_control.updated', control.id);
    expect(updated).toMatchObject(by(primary));
    expect(updated.changes).toEqual({
      notifyPickups: { from: true, to: false },
    });

    const reissued = (
      await x.http('post', `${path}/card`, primary.token).expect(200)
    ).body as { card: { qrPayload: string } };
    const card2 = await single('child_control.card_reissued', control.id, [
      card,
      reissued.card.qrPayload,
    ]);
    expect(card2).toMatchObject(by(primary));
    expect(card2.metadata).toBeNull();

    const photo = await x.files.ready(primary.token, 'child_photo');
    await x
      .http('put', `${path}/photo`, primary.token, { fileId: photo })
      .expect(204);
    const changed = await single('child_control.photo_changed', control.id, [
      photo,
    ]);
    expect(changed).toMatchObject(by(primary));
    expect(changed.changes).toEqual({ photo: { changed: true } });

    await x.http('post', `${path}/off`, primary.token).expect(204);
    const ended = await single('child_control.ended', control.id, [photo]);
    expect(ended).toMatchObject(by(primary));
    expect(ended.metadata).toEqual({
      unitId: home.id,
      memberId,
      reasonCode: 'household',
      escortsRevoked: 0,
    });
  });

  it('a control ended by the child leaving: the remover acts, the reason is the system’s', async () => {
    const { home, primary, memberId, control } = await x.controlled(
      s.c,
      undefined,
      { fullName: CHILD_NAME },
    );
    await x.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).removeMember(memberId, {
        code: 'moved_out',
        text: 'Moved',
      }),
    );
    const ended = await single('child_control.ended', control.id);
    expect(ended).toMatchObject(by(primary));
    expect(ended.metadata).toEqual({
      unitId: home.id,
      memberId,
      reasonCode: 'left_household',
      escortsRevoked: 0,
    });
  });

  it('an escort added, changed, its code reissued, revoked by the household and by the control ending', async () => {
    const { home, primary, memberId } = await x.controlled(s.c, undefined, {
      fullName: CHILD_NAME,
    });
    const PERSON = 'Audited Escortname Sentinel';
    const escort = await x.addEscort(primary, home.id, memberId, {
      ...x.outside(PERSON),
    });
    const phone = (
      await x.inTx(s.c, (tx) =>
        tx.childEscort.findUniqueOrThrow({ where: { id: escort.id } }),
      )
    ).phone!;
    const token = x.tokenOf(escort.pickup!);
    const secrets = [PERSON, phone, token, escort.pickup!.code];
    const as = (action: string) => ({
      ...by(primary),
      action,
      targetType: 'child_escort',
    });
    const added = await single('child_escort.added', escort.id, secrets);
    expect(added).toMatchObject(as('child_escort.added'));
    expect(added.changes).toMatchObject({
      kind: { from: null, to: 'outside' },
      fullName: { changed: true },
      phone: { changed: true },
    });
    const control = (await x.children(primary, home.id))[0].control!;
    expect(added.metadata).toEqual({
      controlId: control.id,
      unitId: home.id,
      memberId,
    });

    const base = `${x.escortsPath(home.id, memberId)}/${escort.id}`;
    await x
      .http('patch', base, primary.token, { schedule: null, validUntil: null })
      .expect(200);
    await x
      .http('patch', base, primary.token, {
        schedule: { days: [1], windows: [{ from: '14:00', to: '15:00' }] },
      })
      .expect(200);
    const updated = await single('child_escort.updated', escort.id, secrets);
    expect(updated.changes).toEqual({
      schedule: {
        from: null,
        to: { days: [1], windows: [{ from: '14:00', to: '15:00' }] },
      },
    });

    const fresh = (
      await x.http('post', `${base}/reissue`, primary.token).expect(200)
    ).body as { pickup: { code: string; link: string } };
    const reissued = await single('child_escort.code_reissued', escort.id, [
      ...secrets,
      fresh.pickup.code,
      fresh.pickup.link,
    ]);
    expect(reissued).toMatchObject(as('child_escort.code_reissued'));
    expect(reissued.metadata).toBeNull();

    await x.http('post', `${base}/revoke`, primary.token).expect(204);
    const revoked = await single('child_escort.revoked', escort.id, secrets);
    expect(revoked.metadata).toEqual({
      controlId: control.id,
      kind: 'outside',
      reasonCode: 'household',
    });

    const second = await x.addEscort(primary, home.id, memberId, x.outside());
    await x
      .http('post', `${x.controlPath(home.id, memberId)}/off`, primary.token)
      .expect(204);
    const off = await single('child_escort.revoked', second.id);
    expect(off.metadata).toMatchObject({ reasonCode: 'control_off' });
    const ended = await single('child_control.ended', control.id);
    expect(ended.metadata).toMatchObject({ escortsRevoked: 1 });
  });

  describe('catalog completeness', () => {
    it('every children entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      const elsewhere = Object.entries(split)
        .filter(([name]) => name !== 'CHILDREN_COVERAGE')
        .flatMap(([, list]) => list);
      for (const key of split.CHILDREN_COVERAGE) {
        expect(all).toContain(key);
        expect(elsewhere).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...split.CHILDREN_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(all.filter((k) => /^child_[a-z_]+\./.test(k)).sort()).toEqual(
        [...split.CHILDREN_COVERAGE].sort(),
      );
    });
  });
});

import { IdentifierHasher } from '../../src/core/auth/identifier';
import { BLOCKLIST_SWEEP } from '../../src/gate/blocklist/blocklist.service';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import {
  securityOpsHelpers,
  type BlocklistBody,
  type Who,
} from '../setup/security-ops';

const DAY = 86_400_000;
const ID = '29001011234567';

/**
 * ADR 0053: the blocklist and the watchlist, kept by `blocklist.manage`. A
 * plate, or a person whose full ID number is kept only as a peppered HMAC
 * bound to the compound; one live entry per plate and per person; the
 * subject never changes; lifted once (by the management, or by the sweep
 * once expired); a person's data goes 30 days after their entry was
 * lifted. The guards on shift read the active list: kind, plate or name,
 * face — never why, never an ID.
 */
describe('Blocklist — entries', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Blocklist Court');
    guard = await x.guardOnDuty(s.c);
    supervisor = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const audit = (action: string, targetId: string) =>
    auditReaders(h).tenant(s.c.tenantId, { action, targetId });
  const hashOf = (id: string) =>
    h.moduleRef.get(IdentifierHasher).hashBlocklistId(s.c.tenantId, id);
  const rowOf = (id: string) =>
    x.inTx(s.c, (tx) => tx.blocklistEntry.findUniqueOrThrow({ where: { id } }));

  it('a plate: banned by the management, tidied, audited by codes; the same plate typed another way is a duplicate', async () => {
    const res = await x
      .blockRaw(s.manager, {
        subject: 'plate',
        plate: ' ق ب ط  8821 ',
        note: 'Seen at night',
      })
      .expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const e = res.body as BlocklistBody;
    expect(e).toMatchObject({
      kind: 'ban',
      subject: 'plate',
      plate: 'ق ب ط 8821',
      fullName: null,
      photo: null,
      status: 'active',
      hasIdNumber: false,
      reasonCode: 'trespassing',
      note: 'Seen at night',
    });
    const [row] = await audit('blocklist_entry.created', e.id);
    expect(row).toMatchObject({ actorId: s.manager.id });
    expect(row.metadata).toEqual({
      kind: 'ban',
      subject: 'plate',
      reasonCode: 'trespassing',
      expiresAt: null,
      photo: false,
      note: true,
    });
    expect(leakText(row)).not.toMatch(/8821|٨٨٢١|Seen at night/);
    await x
      .blockRaw(s.manager, {
        subject: 'plate',
        plate: 'قبط٨٨٢١',
        kind: 'watch',
      })
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'DUPLICATE_RESOURCE',
          fields: [{ field: 'plate', code: 'DUPLICATE_VALUE' }],
        }),
      );
  });

  it('a person: the name and the face kept, the ID number only as its keyed hash, never shown, never in the idempotency record', async () => {
    const face = await x.photo(supervisor);
    const key = { 'Idempotency-Key': `block-person-${Date.now()}` };
    const res = await x
      .blockRaw(
        supervisor,
        {
          kind: 'watch',
          subject: 'person',
          fullName: '  Hamada   Watched ',
          idNumber: '2900-101-1234567',
          photoFileId: face,
          reasonCode: 'harassment',
        },
        key,
      )
      .expect(201);
    const e = res.body as BlocklistBody;
    expect(e).toMatchObject({
      kind: 'watch',
      subject: 'person',
      plate: null,
      fullName: 'Hamada Watched',
      hasIdNumber: true,
    });
    expect(e.photo?.url).toEqual(expect.any(String));
    expect(leakText(res.body)).not.toContain('1234567');
    expect((await rowOf(e.id)).idHash).toBe(hashOf(ID));
    const stored = await x.inTx(s.c, (tx) =>
      tx.$queryRawUnsafe<{ body: unknown; request_hash: string }[]>(
        `SELECT response_body AS body, request_hash FROM idempotency_keys WHERE key = $1`,
        key['Idempotency-Key'],
      ),
    );
    expect(stored).toHaveLength(1);
    expect(leakText(stored)).not.toMatch(/1234567|Hamada/);
    // A replay is rendered afresh: the same entry (the ID number is no part
    // of the request's hash).
    const again = await x
      .blockRaw(
        supervisor,
        {
          kind: 'watch',
          subject: 'person',
          fullName: '  Hamada   Watched ',
          idNumber: '29001011234567',
          photoFileId: face,
          reasonCode: 'harassment',
        },
        key,
      )
      .expect(201);
    expect((again.body as BlocklistBody).id).toBe(e.id);
    // The same person, typed another way, is on the list already.
    await x
      .blockRaw(s.manager, {
        subject: 'person',
        fullName: 'H. Watched',
        idNumber: '٢٩٠٠١٠١١٢٣٤٥٦٧',
      })
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          fields: [{ field: 'idNumber', code: 'DUPLICATE_VALUE' }],
        }),
      );
  });

  it('what does not fit its subject is refused, field by field', async () => {
    const fields = async (body: Record<string, unknown>) =>
      (
        (await x.blockRaw(s.manager, body).expect(400)).body as {
          fields: { field: string; code: string }[];
        }
      ).fields.map((f) => [f.field, f.code]);
    expect(
      await fields({ subject: 'plate', plate: 'ABC 1', fullName: 'Someone' }),
    ).toEqual([['fullName', 'FIELD_NOT_ALLOWED']]);
    expect(await fields({ subject: 'plate' })).toEqual([
      ['plate', 'FIELD_REQUIRED'],
    ]);
    expect(await fields({ subject: 'person', fullName: 'No Id' })).toEqual([
      ['idNumber', 'FIELD_REQUIRED'],
    ]);
    expect(
      await fields({ subject: 'person', fullName: 'Bad Id', idNumber: '12' }),
    ).toEqual([['idNumber', 'INVALID_FORMAT']]);
    expect(
      await fields({
        subject: 'plate',
        plate: 'ABC 2',
        expiresAt: new Date(Date.now() - DAY).toISOString(),
      }),
    ).toEqual([['expiresAt', 'INVALID_VALUE']]);
    expect(
      await fields({ subject: 'plate', plate: 'ABC 3', reasonCode: 'looks' }),
    ).toEqual([['reasonCode', 'INVALID_REASON_CODE']]);
    // A guard, a resident: not theirs to keep.
    for (const who of [guard, s.alice])
      await x.blockRaw(who, { subject: 'plate', plate: 'ABC 4' }).expect(403);
  });

  it('a live entry changes what it says, never what it is about; a new face replaces the old; lifted, it changes no more', async () => {
    const first = await x.photo(s.manager);
    const e = await x.block(s.manager, {
      subject: 'person',
      fullName: 'Changing Person',
      idNumber: 'A1234567',
      photoFileId: first,
    });
    const second = await x.photo(s.manager);
    const patched = await x
      .http('patch', `/staff/security/blocklist/${e.id}`, s.manager.token, {
        kind: 'watch',
        note: 'Calmer now',
        photoFileId: second,
        expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
      })
      .expect(200);
    expect(patched.body).toMatchObject({
      kind: 'watch',
      note: 'Calmer now',
      fullName: 'Changing Person',
    });
    const [row] = await audit('blocklist_entry.updated', e.id);
    expect(row.metadata).toMatchObject({
      changed: ['kind', 'note', 'expiresAt', 'photo'],
      kind: 'watch',
    });
    const old = await x.inTx(s.c, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: first } }),
    );
    expect(old.deletedAt).not.toBeNull();
    // A plate entry has no face.
    const plate = await x.block(s.manager, {
      subject: 'plate',
      plate: 'FACE 1',
    });
    await x
      .http('patch', `/staff/security/blocklist/${plate.id}`, s.manager.token, {
        photoFileId: await x.photo(s.manager),
      })
      .expect(400);
    await x
      .http('post', `/staff/security/blocklist/${e.id}/lift`, s.manager.token, {
        reasonCode: 'resolved',
      })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'lifted',
          liftReason: 'resolved',
          liftedBy: { id: s.manager.id },
        }),
      );
    for (const call of [
      x.http('patch', `/staff/security/blocklist/${e.id}`, s.manager.token, {
        note: 'Again',
      }),
      x.http(
        'post',
        `/staff/security/blocklist/${e.id}/lift`,
        s.manager.token,
        {
          reasonCode: 'other',
        },
      ),
    ])
      await call
        .expect(409)
        .expect((r) =>
          expect(r.body).toMatchObject({ code: 'BLOCKLIST_ENTRY_LIFTED' }),
        );
    // Lifted: the person may be listed again.
    await x
      .blockRaw(s.manager, {
        subject: 'person',
        fullName: 'Changing Person',
        idNumber: 'a1234567',
      })
      .expect(201);
  });

  it('the guards on shift read the active list: kind, plate or name, face; never why or the note; off shift, nothing', async () => {
    const live = await x.block(s.manager, {
      subject: 'plate',
      plate: 'LIST 1',
      note: 'Management only',
    });
    const gone = await x.block(s.manager, {
      subject: 'plate',
      plate: 'LIST 2',
    });
    await x
      .http(
        'post',
        `/staff/security/blocklist/${gone.id}/lift`,
        s.manager.token,
        {
          reasonCode: 'entered_in_error',
        },
      )
      .expect(200);
    const res = await x.http('get', '/gate/blocklist', guard.token).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = res.body as Record<string, unknown>[];
    const mine = list.find((r) => r.id === live.id)!;
    expect(Object.keys(mine).sort()).toEqual(
      ['fullName', 'id', 'kind', 'photo', 'plate', 'since', 'subject'].sort(),
    );
    expect(list.map((r) => r.id)).not.toContain(gone.id);
    expect(leakText(list)).not.toContain('Management only');
    const offShift = await x.guard(s.c);
    await x
      .http('get', '/gate/blocklist', offShift.token)
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'NO_OPEN_SHIFT' }));
    await x.http('get', '/gate/blocklist', s.alice.token).expect(403);
  });

  it('expired: out of the active list at once, lifted by the sweep (system), and a new entry may take its place', async () => {
    const e = await x.block(s.manager, {
      subject: 'plate',
      plate: 'EXP 1',
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    });
    // The day passed.
    await x.inTx(s.c, (tx) =>
      tx.blocklistEntry.update({
        where: { id: e.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    const list = (
      await x.http('get', '/gate/blocklist', guard.token).expect(200)
    ).body as { id: string }[];
    expect(list.map((r) => r.id)).not.toContain(e.id);
    const detail = await x
      .http('get', `/staff/security/blocklist/${e.id}`, s.manager.token)
      .expect(200);
    expect(detail.body).toMatchObject({ status: 'expired', liftedAt: null });
    await x.sweep(BLOCKLIST_SWEEP);
    const after = (
      await x.http('get', `/staff/security/blocklist/${e.id}`, s.manager.token)
    ).body as BlocklistBody;
    expect(after).toMatchObject({ status: 'lifted', liftReason: 'expired' });
    const [row] = await audit('blocklist_entry.expired', e.id);
    expect(row).toMatchObject({ actorType: 'system', actorId: null });
    // Another expired one: listing the plate again lifts it on the way.
    const e2 = await x.block(s.manager, {
      subject: 'plate',
      plate: 'EXP 2',
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    });
    await x.inTx(s.c, (tx) =>
      tx.blocklistEntry.update({
        where: { id: e2.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    await x
      .blockRaw(s.manager, { subject: 'plate', plate: 'EXP 2' })
      .expect(201);
    expect((await rowOf(e2.id)).liftReason).toBe('expired');
  });

  it('30 days after a person’s entry was lifted, their name, ID hash, face and note go, once, audited; a plate stays', async () => {
    const face = await x.photo(s.manager);
    const person = await x.block(s.manager, {
      subject: 'person',
      fullName: 'Purged Person',
      idNumber: 'P9988776',
      photoFileId: face,
      note: 'Purge me',
    });
    const plate = await x.block(s.manager, {
      subject: 'plate',
      plate: 'PRG 1',
    });
    for (const id of [person.id, plate.id])
      await x
        .http('post', `/staff/security/blocklist/${id}/lift`, s.manager.token, {
          reasonCode: 'resolved',
        })
        .expect(200);
    await x.sweep(BLOCKLIST_SWEEP, new Date(Date.now() + 29 * DAY));
    expect((await rowOf(person.id)).purgedAt).toBeNull();
    await x.sweep(BLOCKLIST_SWEEP, new Date(Date.now() + 31 * DAY));
    expect(await rowOf(person.id)).toMatchObject({
      fullName: null,
      idHash: null,
      photoFileId: null,
      note: null,
      purgedAt: expect.any(Date) as Date,
    });
    expect((await rowOf(plate.id)).plate).toBe('PRG 1');
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findUnique({ where: { id: face } }),
    );
    expect(file === null || file.deletedAt !== null).toBe(true);
    const [row] = await audit('blocklist_entry.purged', person.id);
    expect(row).toMatchObject({
      actorType: 'system',
      metadata: { photo: true },
    });
    await x.sweep(BLOCKLIST_SWEEP, new Date(Date.now() + 32 * DAY));
    expect(await audit('blocklist_entry.purged', person.id)).toHaveLength(1);
    expect(
      await x
        .http('get', `/staff/security/blocklist/${person.id}`, s.manager.token)
        .expect(200)
        .then((r) => r.body as BlocklistBody),
    ).toMatchObject({ fullName: null, hasIdNumber: false, photo: null });
  });
});

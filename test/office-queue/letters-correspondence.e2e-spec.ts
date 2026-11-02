import { newId } from '../../src/core/common/uuid';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Letter {
  id: string;
  number: string;
  kind: string;
  status: string;
  subjectName: string | null;
  occupancyType: string;
  verifyCode: string;
}

/**
 * ADR 0080: official letters (issued for an owner or a tenant, drawn as a
 * PDF, checked publicly by an unguessable code that tells only whether it
 * stands, who issued it and when; revoked once) and a unit's
 * correspondence (one timeline, each read logged).
 */
describe('Official letters and a unit’s correspondence', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let stranger: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    stranger = await e.owner(s.c, (await e.unit(s.c, 'B')).id);
  }, 60_000);

  afterAll(() => h.close());

  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const issue = (body: Record<string, unknown>) =>
    e.http('post', '/staff/official-letters', s.manager.token, {
      kind: 'residence_confirmation',
      unitId: s.home.id,
      accountId: s.owner.id,
      ...body,
    });
  const lookup = (code: string) =>
    h
      .http()
      .post('/api/v1/public/letters/lookup')
      .set('X-Forwarded-For', `10.9.${Math.floor(Math.random() * 250)}.1`)
      .send({ code });

  describe('official letters', () => {
    it('issues one for the unit’s owner, with the facts frozen and its subject told; the PDF is drawn for the staff and the subject', async () => {
      const res = await issue({ addressee: 'The bank' }).expect(201);
      const letter = res.body as Letter;
      expect(letter).toMatchObject({
        kind: 'residence_confirmation',
        status: 'valid',
        occupancyType: 'owner',
      });
      expect(letter.number).toMatch(/^OL-\d{6}$/);
      expect(letter.verifyCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(letter.subjectName).toBeTruthy();
      expect(
        (
          await e.notifications(s.c, s.owner.id, 'official_letter.issued')
        ).filter((n) => n.targetId === letter.id),
      ).toHaveLength(1);
      const staffPdf = await e
        .http(
          'get',
          `/staff/official-letters/${letter.id}/pdf`,
          s.manager.token,
        )
        .expect(200);
      expect(staffPdf.headers['content-type']).toMatch(/application\/pdf/);
      expect(staffPdf.headers['cache-control']).toMatch(/no-store/);
      await e
        .http('get', `/me/official-letters/${letter.id}/pdf`, s.owner.token)
        .expect(200);
      await e
        .http('get', `/me/official-letters/${letter.id}/pdf`, stranger.token)
        .expect(404);
      const mine = (
        await e.http('get', '/me/official-letters', s.owner.token).expect(200)
      ).body as { data: { id: string }[] };
      expect(mine.data.map((l) => l.id)).toContain(letter.id);
    });

    it('only for an account holding a place in the unit; a no-objection letter says to what', async () => {
      const res = await issue({ accountId: stranger.id }).expect(409);
      expect(res.body).toMatchObject({ code: 'OFFICIAL_LETTER_NOT_OCCUPANT' });
      const bare = await issue({ kind: 'no_objection' }).expect(400);
      expect(fieldsOf(bare)).toEqual([
        { field: 'subject', code: 'FIELD_REQUIRED' },
      ]);
      await issue({
        kind: 'no_objection',
        subject: 'Renovating the kitchen',
      }).expect(201);
    });

    it('the public check tells only validity, the issuer and the day; any other code is one 404', async () => {
      const letter = (await issue({}).expect(201)).body as Letter;
      const found = await lookup(letter.verifyCode).expect(200);
      expect(Object.keys(found.body as object).sort()).toEqual([
        'issuedOn',
        'issuer',
        'status',
      ]);
      expect(found.body).toMatchObject({ status: 'valid' });
      expect(JSON.stringify(found.body)).not.toContain(letter.number);
      expect(found.headers['cache-control']).toMatch(/no-store/);
      const other = newId().replace(/-/g, '').slice(0, 22);
      const miss = await lookup(other).expect(404);
      expect(miss.body).toMatchObject({ code: 'OFFICIAL_LETTER_NOT_FOUND' });
      await lookup('short').expect(404);
    });

    it('is revoked once, and the check then says so', async () => {
      const letter = (await issue({}).expect(201)).body as Letter;
      const path = `/staff/official-letters/${letter.id}/revoke`;
      const bad = await e
        .http('post', path, s.manager.token, { reasonCode: 'whim' })
        .expect(400);
      expect(fieldsOf(bad)).toEqual([
        expect.objectContaining({ field: 'reasonCode' }),
      ]);
      await e
        .http('post', path, s.manager.token, { reasonCode: 'issued_in_error' })
        .expect(204);
      const again = await e
        .http('post', path, s.manager.token, { reasonCode: 'other' })
        .expect(409);
      expect(again.body).toMatchObject({ code: 'OFFICIAL_LETTER_REVOKED' });
      expect((await lookup(letter.verifyCode).expect(200)).body).toMatchObject({
        status: 'revoked',
      });
    });

    it('a letter is a record: the trigger refuses any other change', async () => {
      const letter = (await issue({}).expect(201)).body as Letter;
      await expect(
        e.inTx(s.c, (tx) =>
          tx.officialLetter.update({
            where: { id: letter.id },
            data: { addressee: 'Someone else' },
          }),
        ),
      ).rejects.toThrow(/a letter is a record/);
    });

    it('a resident issues none', async () => {
      await issue({})
        .set('Authorization', `Bearer ${s.owner.token}`)
        .expect(403);
    });
  });

  describe('a unit’s correspondence', () => {
    it('merges the unit’s requests, letters and announcements to it, newest first, codes only; each read is logged', async () => {
      const request = await e.open(s.c, s.owner, { unitId: s.home.id });
      const announcement = await e.announcement(s.manager, {
        audience: { occupancy: 'everyone', unitIds: [s.home.id] },
      });
      const path = `/staff/units/${s.home.id}/correspondence`;
      const rows = (
        (await e.http('get', path, s.manager.token).expect(200)).body as {
          data: { type: string; id: string; direction: string; at: string }[];
        }
      ).data;
      expect(rows.map((r) => r.type)).toEqual(
        expect.arrayContaining([
          'management_request',
          'official_letter',
          'announcement',
        ]),
      );
      expect(rows.find((r) => r.id === request.id)?.direction).toBe(
        'from_unit',
      );
      expect(rows.find((r) => r.id === announcement)?.direction).toBe(
        'to_unit',
      );
      const times = rows.map((r) => Date.parse(r.at));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      const typed = (
        (
          await e
            .http('get', `${path}?type=official_letter`, s.manager.token)
            .expect(200)
        ).body as { data: { type: string }[] }
      ).data;
      expect(new Set(typed.map((r) => r.type))).toEqual(
        new Set(['official_letter']),
      );
      const logged = await e.inTx(s.c, (tx) =>
        tx.auditLog.count({
          where: { targetId: s.home.id, action: 'unit.correspondence_read' },
        }),
      );
      expect(logged).toBe(2);
    });

    it('pages on one keyset with no row twice', async () => {
      const path = `/staff/units/${s.home.id}/correspondence`;
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = (
          await e
            .http(
              'get',
              `${path}?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
              s.manager.token,
            )
            .expect(200)
        ).body as { data: { id: string }[]; nextCursor: string | null };
        seen.push(...res.data.map((r) => r.id));
        cursor = res.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('is the manager’s: a resident is refused, an unknown unit is a 404', async () => {
      await e
        .http('get', `/staff/units/${s.home.id}/correspondence`, s.owner.token)
        .expect(403);
      await e
        .http('get', `/staff/units/${newId()}/correspondence`, s.manager.token)
        .expect(404);
    });
  });
});

import { acknowledgementDigest } from '../../src/maintenance/field-safety/safety-rules';
import { err } from '../api/request';
import {
  fieldSafetyHelpers,
  type FieldSafetySetUp,
} from '../setup/field-safety';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Instruction {
  id: string;
  categoryId: string;
  version: number;
  textEn: string;
  textAr: string;
}
interface Ack {
  instructionId: string;
  ticketId: string;
  cycle: number;
  contentSha256: string;
}

/**
 * ADR 0067: a category's safety instructions, a version per change, never
 * edited; the technician acknowledges the current version for a ticket's
 * cycle, with the hash of what they were shown, before the work starts or
 * resumes; and what needs a permit is set by who keeps the categories and
 * the asset types.
 */
describe('Field safety — safety instructions and hazards', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof fieldSafetyHelpers>;
  let s: FieldSafetySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = fieldSafetyHelpers(h);
    s = await f.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const publish = (
    categoryId: string,
    textEn: string,
    textAr = 'ارتدِ القفازات',
  ) =>
    f.http(
      'post',
      `/maintenance/categories/${categoryId}/safety-instructions`,
      s.supervisor.token,
      { textEn, textAr },
    );
  const safetyOf = async (id: string) =>
    (
      await f
        .http('get', `/technician/tickets/${id}/safety`, f.tech(s).token)
        .expect(200)
    ).body as { instruction: Instruction | null; acknowledgement: Ack | null };
  const acknowledge = (id: string, instructionId: string) =>
    f.http(
      'post',
      `/technician/tickets/${id}/safety/acknowledge`,
      f.tech(s).token,
      { instructionId },
    );

  it('a change is the next version; the versions are listed latest first; blank text is no text', async () => {
    const cat = await f.category(s);
    const v1 = (await publish(cat, '  Gloves on  ').expect(201))
      .body as Instruction;
    const v2 = (await publish(cat, 'Gloves and goggles').expect(201))
      .body as Instruction;
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1.textEn).toBe('Gloves on');
    const listed = (
      await f
        .http(
          'get',
          `/maintenance/categories/${cat}/safety-instructions`,
          s.manager.token,
        )
        .expect(200)
    ).body as Instruction[];
    expect(listed.map((i) => i.version)).toEqual([2, 1]);
    expect(err(await publish(cat, '   ').expect(400)).fields).toEqual([
      {
        field: 'textEn',
        code: 'INVALID_LENGTH',
        params: { min: 1, max: 4000 },
      },
    ]);
  });

  it('the work starts once the current version is acknowledged for the ticket, its hash what was shown', async () => {
    const cat = await f.category(s);
    const v1 = (await publish(cat, 'Isolate the supply').expect(201))
      .body as Instruction;
    const v2 = (
      await publish(cat, 'Isolate and lock out the supply').expect(201)
    ).body as Instruction;
    const id = await f.assigned(s, cat);
    expect(err(await f.step(s, id, 'start').expect(409))).toMatchObject({
      code: 'SAFETY_ACK_REQUIRED',
      params: { instructionId: v2.id, version: 2 },
    });
    expect(await safetyOf(id)).toMatchObject({
      instruction: { id: v2.id, version: 2 },
      acknowledgement: null,
    });
    expect(err(await acknowledge(id, v1.id).expect(409))).toMatchObject({
      code: 'SAFETY_INSTRUCTION_NOT_CURRENT',
      params: { instructionId: v2.id, version: 2 },
    });
    const ack = (await acknowledge(id, v2.id).expect(200)).body as Ack;
    expect(ack.contentSha256).toBe(
      acknowledgementDigest({
        instructionId: v2.id,
        version: 2,
        textEn: v2.textEn,
        textAr: v2.textAr,
        accountId: f.tech(s).id,
        ticketId: id,
        cycle: 1,
      }),
    );
    // Again is the same acknowledgement.
    expect((await acknowledge(id, v2.id).expect(200)).body).toEqual(ack);
    expect(
      await f.inTenant(s.c, (tx) =>
        tx.safetyAcknowledgement.count({ where: { ticketId: id } }),
      ),
    ).toBe(1);
    await f.step(s, id, 'start').expect(204);
    // A new version while the work is held: acknowledged again to resume.
    await f.step(s, id, 'hold', { holdReason: 'awaiting_parts' }).expect(204);
    const v3 = (await publish(cat, 'Lock out, then test dead').expect(201))
      .body as Instruction;
    expect(err(await f.step(s, id, 'resume').expect(409)).params).toEqual({
      instructionId: v3.id,
      version: 3,
    });
    await acknowledge(id, v3.id).expect(200);
    await f.step(s, id, 'resume').expect(204);
  });

  it('a category without instructions asks for none', async () => {
    const id = await f.assigned(s, await f.category(s));
    expect(await safetyOf(id)).toEqual({
      instruction: null,
      acknowledgement: null,
    });
    expect(err(await acknowledge(id, id).expect(404)).code).toBe(
      'SAFETY_INSTRUCTION_NOT_FOUND',
    );
    await f.step(s, id, 'start').expect(204);
  });

  it('what needs a permit: a category’s by who keeps the categories, an asset type’s by who keeps the register', async () => {
    const cat = await f.category(s);
    const put = (path: string, token: string, hazards: unknown) =>
      f.http('put', path, token, { hazards });
    const catPath = `/maintenance/categories/${cat}/permit-hazards`;
    expect(
      (
        await put(catPath, s.manager.token, [
          'pool_chemicals',
          'hot_work',
          'hot_work',
        ]).expect(200)
      ).body,
    ).toEqual({ hazards: ['hot_work', 'pool_chemicals'] });
    await put(catPath, s.supervisor.token, []).expect(403);
    const listed = (
      (
        await f
          .http('get', '/maintenance/categories', s.manager.token)
          .expect(200)
      ).body as {
        data: { id: string; requiresPermit: string[] }[];
      }
    ).data.find((c) => c.id === cat);
    expect(listed?.requiresPermit).toEqual(['hot_work', 'pool_chemicals']);
    const typeId = await f.typeId(s, 'generator');
    const typePath = `/maintenance/asset-types/${typeId}/permit-hazards`;
    expect(
      (await put(typePath, s.supervisor.token, ['live_electrical']).expect(200))
        .body,
    ).toEqual({
      hazards: ['live_electrical'],
    });
    await put(typePath, f.tech(s).token, []).expect(403);
    await put(typePath, s.supervisor.token, []).expect(200);
  });
});

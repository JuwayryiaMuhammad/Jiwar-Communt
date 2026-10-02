import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
} from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { fileHelpers, SAMPLE } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per files catalog entry (ADR 0014, 0029): actor, target and
 * metadata — purpose, type, size and a reason code, never a file name.
 */
const covered = new Set<string>();

describe('Audit coverage — files', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let f: ReturnType<typeof fileHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    f = fileHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  it('file.created and file.deleted — by the owner', async () => {
    const c = await x.compound();
    const unit = await x.unit(c);
    const r = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: r.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    const id = await f.ready(token, 'worker_photo', 'image/png');

    const created = await single(c, 'file.created', id);
    expect(created).toMatchObject({
      actorType: 'account',
      actorId: r.id,
      targetType: 'file',
      changes: null,
    });
    expect(created.metadata).toEqual({
      purpose: 'worker_photo',
      contentType: 'image/png',
      size: SAMPLE['image/png'].length,
    });

    await h
      .http()
      .delete(`${API}/files/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const deleted = await single(c, 'file.deleted', id);
    expect(deleted).toMatchObject({
      actorType: 'account',
      actorId: r.id,
      targetType: 'file',
    });
    expect(deleted.metadata).toEqual({
      purpose: 'worker_photo',
      reasonCode: 'owner',
    });
  });

  describe('catalog completeness', () => {
    it('every files entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FILES_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...FILES_COVERAGE].sort());
    });
  });
});

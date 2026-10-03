import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { WORKER_PHOTO_RETENTION_SWEEP } from '../../src/community/workers/photo-retention';
import {
  WorkersService,
  type NewWorker,
} from '../../src/community/workers/workers.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { workerBody } from '../api/routes/workers';
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
 * metadata — purpose, type, size and a reason code, never a file name; a
 * worker's photo as { changed: true } only.
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

  it('worker.photo_changed — by the manager, then by the retention sweep', async () => {
    const c = await x.compound();
    const unit = await x.unit(c);
    const r = await x.resident(c, [unit.id]);
    const { engagementId } = await x.as(c, { id: r.id, type: 'resident' }, () =>
      h.moduleRef
        .get(WorkersService)
        .register(unit.id, workerBody() as unknown as NewWorker),
    );
    const { workerId } = await x.asManager(c, () =>
      x.prisma.tenant.workerEngagement.findUniqueOrThrow({
        where: { id: engagementId },
      }),
    );
    const manager = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
    const fileId = await f.ready(manager);
    await h
      .http()
      .put(`${API}/workers/${workerId}/photo`)
      .set('Authorization', `Bearer ${manager}`)
      .send({ fileId })
      .expect(204);
    const set = await single(c, 'worker.photo_changed', workerId);
    expect(set).toMatchObject({
      actorType: 'account',
      actorId: c.managerId,
      targetType: 'domestic_worker',
      changes: { photo: { changed: true } },
    });
    expect(JSON.stringify(set)).not.toContain(fileId);

    // Retention (ADR 0029): the worker's last engagement long closed.
    await x.asManager(c, () =>
      h.moduleRef.get(WorkersService).end(engagementId, {
        code: 'work_finished',
        text: 'Done',
      }),
    );
    await x.asManager(c, () =>
      x.prisma.tenant.workerEngagement.updateMany({
        where: { workerId },
        data: { updatedAt: new Date(Date.now() - 91 * 86_400_000) },
      }),
    );
    await h.moduleRef.get(SweepRunner).run(WORKER_PHOTO_RETENTION_SWEEP);
    const rows = await read.tenant(c.tenantId, {
      action: 'worker.photo_changed',
      targetId: workerId,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      actorType: 'system',
      changes: { photo: { changed: true } },
      metadata: { reasonCode: 'retention' },
    });
    const dropped = await single(c, 'file.deleted', fileId);
    expect(dropped.metadata).toEqual({
      purpose: 'worker_photo',
      reasonCode: 'retention',
    });
  });

  it('account.photo_changed — set, replaced and removed by the account itself', async () => {
    const c = await x.compound();
    const unit = await x.unit(c);
    const r = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: r.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    const put = (fileId: string) =>
      h
        .http()
        .put(`${API}/me/photo`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fileId })
        .expect(204);
    const first = await f.ready(token, 'resident_photo');
    await put(first);
    const second = await f.ready(token, 'resident_photo');
    await put(second);
    await h
      .http()
      .delete(`${API}/me/photo`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const rows = await read.tenant(c.tenantId, {
      action: 'account.photo_changed',
      targetId: r.id,
    });
    covered.add('account.photo_changed');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: r.id,
        targetType: 'account',
        changes: { photo: { changed: true } },
      });
      for (const id of [first, second])
        expect(JSON.stringify(row)).not.toContain(id);
    }
    // A replaced and a removed file are deleted with their reason.
    expect((await single(c, 'file.deleted', first)).metadata).toEqual({
      purpose: 'resident_photo',
      reasonCode: 'replaced',
    });
    expect((await single(c, 'file.deleted', second)).metadata).toEqual({
      purpose: 'resident_photo',
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

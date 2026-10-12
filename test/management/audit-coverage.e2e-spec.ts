import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers, type ManagementSetUp } from '../setup/management';

/**
 * One scenario per management catalog entry (ADR 0014, 0039): actor, target,
 * changes and metadata — ids, numbers, keys and reason codes; never a
 * message, a note, a rating's comment or a topic's name.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — management requests', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    read = auditReaders(h);
  }, 60_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  describe('set-up', () => {
    let topicId: string;

    it('management_request_topic.created — the key and target by value, the names as changed', async () => {
      const res = await m
        .http('post', '/management/request-topics', s.manager.token, {
          key: 'pool',
          nameAr: `${MARKER} ع`,
          nameEn: `${MARKER} Pool`,
          targetResponseHours: 12,
        })
        .expect(201);
      topicId = (res.body as { id: string }).id;
      const row = await single('management_request_topic.created', topicId);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.manager.id,
        targetType: 'management_request_topic',
      });
      expect(row.changes).toEqual({
        key: { from: null, to: 'pool' },
        nameAr: { changed: true },
        nameEn: { changed: true },
        targetResponseHours: { from: null, to: 12 },
        active: { from: null, to: true },
      });
    });

    it('management_request_topic.updated — only what changed; nothing when nothing did', async () => {
      const patch = (body: object) =>
        m
          .http(
            'patch',
            `/management/request-topics/${topicId}`,
            s.manager.token,
            body,
          )
          .expect(200);
      await patch({
        nameEn: `${MARKER} Pool area`,
        targetResponseHours: 24,
        active: false,
      });
      const row = await single('management_request_topic.updated', topicId);
      expect(row.changes).toEqual({
        nameEn: { changed: true },
        targetResponseHours: { from: 12, to: 24 },
        active: { from: true, to: false },
      });
      // The same values again: no row.
      await patch({ targetResponseHours: 24, active: false });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management_request_topic.updated',
          targetId: topicId,
        }),
      ).toHaveLength(1);
    });

    it('management.settings_changed — the fields that changed, by value', async () => {
      const patch = (body: object) =>
        m
          .http('patch', '/management/request-settings', s.manager.token, body)
          .expect(200);
      await patch({ autoCloseDays: 14, appointmentSlotCapacity: 3 });
      const row = await single('management.settings_changed', s.c.tenantId);
      expect(row).toMatchObject({
        actorId: s.manager.id,
        targetType: 'tenant',
      });
      expect(row.changes).toEqual({
        autoCloseDays: { from: 7, to: 14 },
        appointmentSlotCapacity: { from: 1, to: 3 },
      });
      await patch({ autoCloseDays: 14 });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management.settings_changed',
          targetId: s.c.tenantId,
        }),
      ).toHaveLength(1);
    });

    it('management.office_hours_changed — the set before and after, as numbers', async () => {
      const windows = [{ weekday: 1, startMinute: 600, endMinute: 720 }];
      const put = () =>
        m
          .http('put', '/management/office-hours', s.manager.token, { windows })
          .expect(200);
      await put();
      const row = await single('management.office_hours_changed', s.c.tenantId);
      expect(row).toMatchObject({
        actorId: s.manager.id,
        targetType: 'tenant',
      });
      expect(row.changes).toEqual({
        windows: {
          from: [0, 1, 2, 3, 4, 6].map((d) => `${d}:540-1020`),
          to: ['1:600-720'],
        },
      });
      // The same set again: no row.
      await put();
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management.office_hours_changed',
          targetId: s.c.tenantId,
        }),
      ).toHaveLength(1);
    });
  });

  describe('catalog completeness', () => {
    it('every management entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of MANAGEMENT_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...MANAGEMENT_COVERAGE].sort());
    });
  });
});

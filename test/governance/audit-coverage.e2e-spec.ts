import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  GOVERNANCE_COVERAGE,
  GUARD_DUTY_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import {
  governanceHelpers,
  lapse,
  type StaffTermBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per governance catalog entry (ADR 0014, 0051): actor,
 * target, changes and metadata — ids, roles, codes, dates and counts by
 * value; never a name, a statement or what anyone chose.
 */
const covered = new Set<string>();

describe('Audit coverage — governance', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(5);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });
  const o = (i: number) => s.owners[i];

  describe('the board', () => {
    let first: StaffTermBody;

    it('appointed: seats, dates and the members by id and role; each seat added', async () => {
      first = await g.appoint(s.manager, [o(0), o(1), o(2)], { seats: 4 });
      const a = await single('board_term.appointed', first.id);
      expect(a).toMatchObject(by(s.manager, 'board_term'));
      expect(a.metadata).toEqual({
        seats: 4,
        startsAt: first.startsAt,
        endsAt: first.endsAt,
        members: [
          { accountId: o(0).id, role: 'chair' },
          { accountId: o(1).id, role: 'member' },
          { accountId: o(2).id, role: 'member' },
        ],
        lapsedTermId: null,
      });
      const seat = first.members[1];
      const added = await single('board_member.added', seat.id);
      expect(added).toMatchObject(by(s.manager, 'board_member'));
      expect(added.metadata).toEqual({
        termId: first.id,
        accountId: o(1).id,
        role: 'member',
        source: 'appointed',
      });
    });

    it('role_changed: from and to', async () => {
      const seat = first.members[1];
      await g
        .http(
          'patch',
          `/staff/governance/board/members/${seat.id}`,
          s.manager.token,
          {
            role: 'treasurer',
          },
        )
        .expect(200);
      const c = await single('board_member.role_changed', seat.id);
      expect(c).toMatchObject(by(s.manager, 'board_member'));
      expect(c.metadata).toEqual({
        termId: first.id,
        accountId: o(1).id,
        from: 'member',
        to: 'treasurer',
      });
    });

    it('ended: the reason’s code and the side', async () => {
      const seat = first.members[2];
      await g
        .http(
          'post',
          `/staff/governance/board/members/${seat.id}/end`,
          s.manager.token,
          {
            reasonCode: 'resigned',
          },
        )
        .expect(200);
      const e = await single('board_member.ended', seat.id);
      expect(e).toMatchObject(by(s.manager, 'board_member'));
      expect(e.metadata).toEqual({
        termId: first.id,
        accountId: o(2).id,
        reasonCode: 'resigned',
        side: 'manager',
      });
    });

    it('term ended: replaced by the next appointment after a lapse', async () => {
      await lapse(first.id);
      const next = await g.appoint(s.manager, [o(2), o(3), o(4)]);
      const ended = await single('board_term.ended', first.id);
      expect(ended).toMatchObject(by(s.manager, 'board_term'));
      expect(ended.metadata).toEqual({ reason: 'replaced', byTermId: next.id });
      const appointed = (
        await read.tenant(s.c.tenantId, {
          action: 'board_term.appointed',
          targetId: next.id,
        })
      )[0];
      expect(appointed.metadata).toMatchObject({ lapsedTermId: first.id });
    });
  });

  describe('catalog completeness', () => {
    it('every governance entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of GOVERNANCE_COVERAGE) {
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
          ...MANAGEMENT_COVERAGE,
          ...ENGAGEMENT_COVERAGE,
          ...NEIGHBOURS_COVERAGE,
          ...FACILITIES_COVERAGE,
          ...VEHICLES_COVERAGE,
          ...FINANCE_COVERAGE,
          ...SAFETY_COVERAGE,
          ...PERMITS_COVERAGE,
          ...GUARD_DUTY_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...GOVERNANCE_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) =>
            /^(board_term|board_member|governance_poll|governance_election|governance_candidate|board_publication)\.|^governance\./.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...GOVERNANCE_COVERAGE].sort());
    });
  });
});

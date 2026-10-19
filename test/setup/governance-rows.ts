import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbDate, localDay } from './compound-clock';

// ============================================================================
// Governance rows written straight into the tables (ADR 0051), for the
// suites that test the database itself: the schema and isolation suites.
// Each returns the row's id.
// ============================================================================

const DAY = 86_400_000;

/**
 * A board term that ended already (a compound holds one open term at most,
 * so a row helper never leaves one open unless asked).
 */
export async function boardTermRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string; open?: boolean; seats?: number },
): Promise<string> {
  const id = newId();
  const startsAt = new Date(Date.now() - 400 * DAY);
  await tx.boardTerm.create({
    data: {
      id,
      tenantId: r.tenantId,
      source: 'appointed',
      seats: r.seats ?? 3,
      startsAt,
      endsAt: new Date(Date.now() + (r.open ? 365 : -35) * DAY),
      ...(r.open
        ? {}
        : { endedAt: new Date(Date.now() - 35 * DAY), endReason: 'replaced' }),
      createdById: r.createdById,
      createdAt: startsAt,
    },
  });
  return id;
}

export async function boardMemberRow(
  tx: TenantTxClient,
  r: { tenantId: string; termId: string; accountId: string; addedById: string },
): Promise<string> {
  const id = newId();
  await tx.boardMember.create({
    data: {
      id,
      tenantId: r.tenantId,
      termId: r.termId,
      accountId: r.accountId,
      role: 'member',
      addedAt: new Date(Date.now() - 400 * DAY),
      addedById: r.addedById,
    },
  });
  return id;
}

/** A contest that has not opened; its id. */
export async function contestRow(
  tx: TenantTxClient,
  r: { tenantId: string; secret?: boolean; kind?: 'poll' | 'election' },
): Promise<string> {
  const id = newId();
  await tx.governanceContest.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: r.kind ?? 'poll',
      secret: r.secret ?? true,
      maxChoices: 1,
      opensAt: new Date(Date.now() + DAY),
      closesAt: new Date(Date.now() + 2 * DAY),
    },
  });
  return id;
}

/** The contest opens now with its electors (one per unit), and a box when secret. */
export async function openContest(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    contestId: string;
    electors: { unitId: string; accountId: string }[];
  },
): Promise<void> {
  for (const e of r.electors)
    await tx.governanceElector.create({
      data: { tenantId: r.tenantId, contestId: r.contestId, ...e },
    });
  const contest = await tx.governanceContest.update({
    where: { id: r.contestId },
    data: { openedAt: new Date(), electorate: r.electors.length },
  });
  if (contest.secret)
    await tx.governanceBallotBox.create({
      data: { tenantId: r.tenantId, contestId: r.contestId },
    });
}

/**
 * A secret contest that opened, took one vote and closed: its participation
 * and its one ballot row, as the close writes them. Returns the contest id.
 */
export async function closedContestRows(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; accountId: string },
): Promise<string> {
  const contestId = await contestRow(tx, { tenantId: r.tenantId });
  await openContest(tx, {
    tenantId: r.tenantId,
    contestId,
    electors: [{ unitId: r.unitId, accountId: r.accountId }],
  });
  await tx.$executeRaw`
    INSERT INTO governance_participations
      (tenant_id, contest_id, unit_id, voter_account_id, voted_at, secret)
    VALUES (${r.tenantId}::uuid, ${contestId}::uuid, ${r.unitId}::uuid,
            ${r.accountId}::uuid, now(), true)`;
  await tx.governanceContest.update({
    where: { id: contestId },
    data: { closedAt: new Date(), turnout: 1 },
  });
  await tx.$executeRaw`
    INSERT INTO governance_ballots (id, tenant_id, contest_id, choice)
    VALUES (gen_random_uuid(), ${r.tenantId}::uuid, ${contestId}::uuid,
            ARRAY[gen_random_uuid()])`;
  await tx.governanceBallotBox.delete({
    where: { tenantId_contestId: { tenantId: r.tenantId, contestId } },
  });
  return contestId;
}

let pollNumber = 1;

/** A yes/no poll on a contest of its own (not opened); its id. */
export async function pollRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string; contestId?: string },
): Promise<string> {
  const id = newId();
  const contestId =
    r.contestId ?? (await contestRow(tx, { tenantId: r.tenantId }));
  await tx.governancePoll.create({
    data: {
      id,
      tenantId: r.tenantId,
      contestId,
      number: 800_000 + pollNumber++ + Math.floor(Math.random() * 90_000),
      kind: 'yes_no',
      titleEn: 'A poll',
      bodyEn: 'Its question.',
      quorumPct: 50,
      thresholdPct: 50,
      authorSide: 'manager',
      createdById: r.createdById,
    },
  });
  for (const [i, key] of ['yes', 'no', 'abstain'].entries())
    await tx.governancePollOption.create({
      data: {
        id: newId(),
        tenantId: r.tenantId,
        pollId: id,
        position: i + 1,
        key,
      },
    });
  return id;
}

let electionNumber = 1;

/**
 * An election on a contest of its own (nominations open since a day, the
 * vote tomorrow) with one candidate; its id and the candidate's.
 */
export async function electionRows(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string; candidateId?: string },
): Promise<{ electionId: string; candidateId: string }> {
  const contestId = newId();
  const now = Date.now();
  await tx.governanceContest.create({
    data: {
      id: contestId,
      tenantId: r.tenantId,
      kind: 'election',
      secret: true,
      maxChoices: 3,
      opensAt: new Date(now + DAY),
      closesAt: new Date(now + 2 * DAY),
    },
  });
  const electionId = newId();
  await tx.governanceElection.create({
    data: {
      id: electionId,
      tenantId: r.tenantId,
      contestId,
      number: 800_000 + electionNumber++ + Math.floor(Math.random() * 90_000),
      titleEn: 'An election',
      bodyEn: 'Its words.',
      seats: 3,
      termMonths: 24,
      nominationsOpenAt: new Date(now - DAY),
      nominationsCloseAt: new Date(now + DAY),
      authorSide: 'manager',
      createdById: r.createdById,
    },
  });
  const candidateId = newId();
  await tx.governanceCandidate.create({
    data: {
      id: candidateId,
      tenantId: r.tenantId,
      electionId,
      accountId: r.candidateId ?? r.createdById,
      statement: 'A statement',
      nominatedAt: new Date(now - DAY),
    },
  });
  return { electionId, candidateId };
}

/** A decision of the board: its announcement (kind `board`) and its record; the record's id. */
export async function publicationRows(
  tx: TenantTxClient,
  r: { tenantId: string; termId: string; accountId: string },
): Promise<string> {
  const announcementId = newId();
  const now = new Date();
  await tx.announcement.create({
    data: {
      id: announcementId,
      tenantId: r.tenantId,
      kind: 'board',
      publishAt: now,
      audienceOccupancy: 'owners',
      createdById: r.accountId,
    },
  });
  await tx.announcementVersion.create({
    data: {
      id: newId(),
      tenantId: r.tenantId,
      announcementId,
      version: 1,
      titleEn: 'A decision',
      bodyEn: 'Its words.',
      editedById: r.accountId,
    },
  });
  const id = newId();
  await tx.boardPublication.create({
    data: {
      id,
      tenantId: r.tenantId,
      kind: 'decision',
      termId: r.termId,
      announcementId,
      decidedOn: dbDate(localDay(now)),
      authorSide: 'manager',
      publishedById: r.accountId,
    },
  });
  return id;
}

/**
 * A pending approval request of a type that names no subject (ADR 0055),
 * numbered past anything a suite raises; its id.
 */
export async function approvalRequestRow(
  tx: TenantTxClient,
  r: { tenantId: string; raisedById: string; number?: number },
): Promise<string> {
  const id = newId();
  const createdAt = new Date(Date.now() - DAY);
  await tx.governanceApprovalRequest.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: r.number ?? 9000,
      type: 'legal_escalation',
      raisedById: r.raisedById,
      context: 'A row',
      impact: 'None',
      deadlineAt: new Date(createdAt.getTime() + 14 * DAY),
      createdAt,
    },
  });
  return id;
}

/** An open motion on a request, by a seated member; its id. */
export async function motionRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    requestId: string;
    termId: string;
    memberId: string;
    accountId: string;
  },
): Promise<string> {
  const id = newId();
  await tx.boardMotion.create({
    data: {
      id,
      tenantId: r.tenantId,
      approvalRequestId: r.requestId,
      termId: r.termId,
      proposedByMemberId: r.memberId,
      proposedById: r.accountId,
      outcome: 'approve',
      rationale: 'A row',
      openedAt: new Date(),
    },
  });
  return id;
}

/** A pending appeal to the board of a made-up decision about a unit; its id. */
export async function appealRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    unitId: string;
    appellantId: string;
    number?: number;
  },
): Promise<string> {
  const id = newId();
  const lodgedAt = new Date(Date.now() - DAY);
  await tx.governanceBoardAppeal.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: r.number ?? 9000,
      kind: 'invoice_dispute',
      subjectId: newId(),
      unitId: r.unitId,
      appellantId: r.appellantId,
      grounds: 'A row',
      decisionAt: new Date(lodgedAt.getTime() - DAY),
      lodgedAt,
      deadlineAt: new Date(lodgedAt.getTime() + 30 * DAY),
    },
  });
  return id;
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  Announcement,
  AnnouncementKind,
  AnnouncementPriority,
  AnnouncementVersion,
  Prisma,
  WorksAreaKind,
} from '@prisma/client';
import { CommunityEngagementPort, type Audience } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { GateStatusPort, type GateStatus } from '../../gate';
import { EngagementAccess } from '../access';
import {
  audienceColumns,
  audienceOf,
  audienceWhere,
  placesIn,
  sees,
} from '../audience/audience';
import { AudienceCheck } from '../audience/audience-check';
import {
  CommunityAttachments,
  type AttachmentRead,
} from '../content/attachments';
import {
  invalid,
  localized,
  namesText,
  sameText,
  type Localized,
} from '../../core/common/localized';
import { dbNow } from '../db-clock';
import { OpaqueRefs, sameRef } from '../refs/opaque-refs';
import {
  isAhead,
  isOut,
  isPinned,
  outWhere,
  statusOf,
  statusWhere,
  worksActive,
  type AnnouncementStatus,
} from './announcement-rules';

/** The CHECKs announcement_versions_lengths and announcements_works_place_length. */
export const TITLE_MAX = 150;
export const BODY_MAX = 5000;
export const PLACE_MAX = 200;

export const ANNOUNCEMENT_STATUSES = [
  'draft',
  'scheduled',
  'published',
  'expired',
  'ended',
  'archived',
] as const satisfies readonly AnnouncementStatus[];

export const ANNOUNCEMENT_RESOURCE = 'announcement';
export const ANNOUNCE_SWEEP = 'engagement.announce';
const ANNOUNCE_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 100;

const TEXT = [
  { name: 'title', max: TITLE_MAX },
  { name: 'body', max: BODY_MAX },
] as const;

export interface WorksInput {
  startsAt: Date;
  endsAt: Date;
  areaKind: WorksAreaKind;
  gateId?: string | null;
  place?: string | null;
}

interface ContentInput {
  titleEn?: string | null;
  bodyEn?: string | null;
  titleAr?: string | null;
  bodyAr?: string | null;
  priority?: AnnouncementPriority;
  pinnedUntil?: Date | null;
  expiresAt?: Date | null;
  audience?: { buildings?: string[] | null; occupancy: Audience['occupancy'] };
  attachmentFileIds?: string[];
  works?: WorksInput;
}

export interface NewAnnouncement extends ContentInput {
  kind: AnnouncementKind;
}

export type AnnouncementUpdate = ContentInput;

export interface StaffAnnouncementsQuery {
  status?: AnnouncementStatus;
  kind?: AnnouncementKind;
  cursor?: string;
  limit: number;
}

export interface AnnouncementsQuery {
  kind?: AnnouncementKind;
  pinned?: boolean;
  cursor?: string;
  limit: number;
}

/** An announcement as it is read: the row, what it says now, and where it stands. */
export interface AnnouncementRead {
  announcement: Announcement;
  version: AnnouncementVersion;
  status: AnnouncementStatus;
  pinned: boolean;
  worksActive: boolean;
  /** The gate works are at, when they name one. */
  gate: GateStatus | null;
  /** Null in a list: the count is enough there. */
  attachments: AttachmentRead[] | null;
  /** Whether the reader opened it; null for the staff. */
  read: boolean | null;
}

export interface VersionRead {
  version: AnnouncementVersion;
  attachments: AttachmentRead[];
}

export interface ReadCounts {
  /** Accounts that opened it. */
  accounts: number;
  /** Units at least one of whose people opened it. */
  units: number;
  /** Who it is put to right now. */
  audienceAccounts: number;
  audienceUnits: number;
}

const byCreation = keysetCursor('createdAt');
const byPublication = keysetCursor('publishAt');

export const announcementNotFound = () =>
  appError.notFound(ErrorCode.ANNOUNCEMENT_NOT_FOUND, 'Announcement not found');

const wrongState = (status: AnnouncementStatus) =>
  appError.conflict(
    ErrorCode.ANNOUNCEMENT_INVALID_STATE,
    'The announcement does not take this action now',
    { params: { status } },
  );

/** What the settings of an announcement are, apart from what it says. */
interface Settings {
  priority: AnnouncementPriority;
  pinnedUntil: Date | null;
  expiresAt: Date | null;
  works: {
    startsAt: Date;
    endsAt: Date;
    areaKind: WorksAreaKind;
    gateId: string | null;
    place: string | null;
  } | null;
}

/** What may not stand together, as field errors (the CHECKs say the same). */
function shapeErrors(
  kind: AnnouncementKind,
  s: Settings,
  publishAt: Date | null,
): FieldError[] {
  const errors: FieldError[] = [];
  if (kind === 'works' && !s.works)
    errors.push({ field: 'works', code: FieldErrorCode.FIELD_REQUIRED });
  if (kind === 'general' && s.works)
    errors.push({ field: 'works', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  if (s.works) {
    if (s.works.endsAt <= s.works.startsAt)
      errors.push({
        field: 'works.endsAt',
        code: FieldErrorCode.ENDS_BEFORE_START,
      });
    if (s.works.gateId && s.works.areaKind !== 'gate')
      errors.push({
        field: 'works.gateId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  }
  if (s.pinnedUntil && s.priority !== 'important')
    errors.push({
      field: 'pinnedUntil',
      code: FieldErrorCode.FIELD_NOT_ALLOWED,
    });
  if (s.expiresAt && kind === 'works')
    errors.push({ field: 'expiresAt', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  else if (s.expiresAt && publishAt && s.expiresAt <= publishAt)
    errors.push({
      field: 'expiresAt',
      code: FieldErrorCode.ENDS_BEFORE_START,
    });
  return errors;
}

function settingsOf(a: Announcement): Settings {
  return {
    priority: a.priority,
    pinnedUntil: a.pinnedUntil,
    expiresAt: a.expiresAt,
    works:
      a.kind === 'works'
        ? {
            startsAt: a.worksStartsAt!,
            endsAt: a.worksEndsAt!,
            areaKind: a.worksAreaKind!,
            gateId: a.worksGateId,
            place: a.worksPlace,
          }
        : null,
  };
}

function worksOf(input: WorksInput | undefined): Settings['works'] {
  return input
    ? {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        areaKind: input.areaKind,
        gateId: input.gateId ?? null,
        place: input.place?.trim() || null,
      }
    : null;
}

const settingsColumns = (s: Settings) => ({
  priority: s.priority,
  pinnedUntil: s.pinnedUntil,
  expiresAt: s.expiresAt,
  worksStartsAt: s.works?.startsAt ?? null,
  worksEndsAt: s.works?.endsAt ?? null,
  worksAreaKind: s.works?.areaKind ?? null,
  worksGateId: s.works?.gateId ?? null,
  worksPlace: s.works?.place ?? null,
});

/**
 * What the audit trail records of an announcement: its settings by value
 * and never what it says. The place of works is the staff's words: marked
 * sensitive, recorded as "changed" only.
 */
function audited(a: Announcement) {
  return {
    kind: a.kind,
    priority: a.priority,
    pinnedUntil: a.pinnedUntil,
    expiresAt: a.expiresAt,
    audienceOccupancy: a.audienceOccupancy,
    audienceBuildings: a.audienceBuildings,
    worksStartsAt: a.worksStartsAt,
    worksEndsAt: a.worksEndsAt,
    worksAreaKind: a.worksAreaKind,
    worksGateId: a.worksGateId,
    worksPlace: a.worksPlace,
  };
}

const textOf = (v: AnnouncementVersion): Localized => ({
  titleEn: v.titleEn,
  bodyEn: v.bodyEn,
  titleAr: v.titleAr,
  bodyAr: v.bodyAr,
});

/**
 * Announcements, and works and closures as a kind of them (ADR 0040).
 *
 * The staff write, schedule, edit and archive them (`community.publish`);
 * an edit adds a version and nothing is rewritten. Residents read what is
 * out and put to them now: the audience is a rule, evaluated against the
 * caller's places at each read, so a newcomer sees what is live and someone
 * who left sees nothing. An important announcement tells its audience when
 * it comes out, once.
 *
 * Who read one is never stored: `markRead` leaves keyed marks, which the
 * staff see as two counts and nothing else.
 */
@Injectable()
export class AnnouncementsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: EngagementAccess,
    private readonly community: CommunityEngagementPort,
    private readonly audiences: AudienceCheck,
    private readonly gates: GateStatusPort,
    private readonly attachments: CommunityAttachments,
    private readonly refs: OpaqueRefs,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    // A replay whose stored body was lost renders the announcement as created.
    this.idempotency.renderer(ANNOUNCEMENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const a = await tx.announcement.findUniqueOrThrow({ where: { id } });
        return { id: a.id, createdAt: a.createdAt };
      }),
    );
    this.sweep.register(ANNOUNCE_SWEEP, (now) => this.announceDue(now), {
      intervalMs: ANNOUNCE_INTERVAL_MS,
    });
  }

  // --------------------------------------------------------------------------
  // Writing (staff)
  // --------------------------------------------------------------------------

  /** A draft: nobody reads it until it is published. */
  create(input: NewAnnouncement): Promise<Announcement> {
    const text = localized(input, TEXT);
    const settings: Settings = {
      priority: input.priority ?? 'normal',
      pinnedUntil: input.pinnedUntil ?? null,
      expiresAt: input.expiresAt ?? null,
      works: worksOf(input.works),
    };
    const errors = shapeErrors(input.kind, settings, null);
    if (errors.length) throw invalid(errors);
    const fileIds = this.attachments.ids(
      input.attachmentFileIds,
      'attachmentFileIds',
    );
    const tenantId = this.ctx.tenantId;
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: ANNOUNCEMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const audience = await this.audiences.check(tx, input.audience);
      await this.requireGate(tx, settings);
      const now = await dbNow(tx);
      const announcement = await tx.announcement.create({
        data: {
          id,
          tenantId,
          kind: input.kind,
          ...settingsColumns(settings),
          ...audienceColumns(audience),
          createdById: me,
          createdAt: now,
        },
      });
      const attachmentIds: string[] = [];
      for (const [i, fileId] of fileIds.entries())
        attachmentIds.push(await this.attach(tx, announcement, fileId, i, now));
      await this.writeVersion(tx, announcement, 1, text, attachmentIds, now);
      await this.audit.record(tx, {
        action: 'announcement.created',
        targetId: id,
        changes: diffChanges(
          null,
          audited(announcement),
          'announcement.created',
        ),
      });
      return announcement;
    });
  }

  /**
   * Changes an announcement that is not archived. New words or files make a
   * new version, the old one kept; once it is out, that shows as "edited".
   * The audience and the kind are fixed once it is out: who was told and
   * who has read would no longer match.
   */
  update(id: string, input: AnnouncementUpdate): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = statusOf(before, now);
      if (status === 'archived') throw wrongState(status);

      const priority = input.priority ?? before.priority;
      const settings: Settings = {
        priority,
        // A pin is an important announcement's: it goes with the priority.
        pinnedUntil:
          input.pinnedUntil !== undefined
            ? input.pinnedUntil
            : priority === 'important'
              ? before.pinnedUntil
              : null,
        expiresAt:
          input.expiresAt !== undefined ? input.expiresAt : before.expiresAt,
        works: input.works ? worksOf(input.works) : settingsOf(before).works,
      };
      const errors = shapeErrors(before.kind, settings, before.publishAt);
      if (errors.length) throw invalid(errors);

      let audience = audienceColumns(audienceOf(before));
      if (input.audience) {
        const next = audienceColumns(
          await this.audiences.check(tx, input.audience),
        );
        const same =
          next.audienceOccupancy === audience.audienceOccupancy &&
          next.audienceBuildings.join('\n') ===
            audience.audienceBuildings.join('\n');
        if (!same && !isAhead(before, now)) throw wrongState(status);
        audience = next;
      }
      if (settings.works?.gateId !== before.worksGateId)
        await this.requireGate(tx, settings);

      const current = await this.versionOf(tx, before);
      let version = current.version;
      if (namesText(input, TEXT) || input.attachmentFileIds !== undefined) {
        const text = localized(input, TEXT, textOf(current));
        const attachmentIds =
          input.attachmentFileIds === undefined
            ? current.attachmentIds
            : await this.attachmentSet(
                tx,
                before,
                current,
                input.attachmentFileIds,
                now,
              );
        const changed =
          !sameText(text, textOf(current)) ||
          attachmentIds.join() !== current.attachmentIds.join();
        if (changed) {
          version = current.version + 1;
          await this.writeVersion(
            tx,
            before,
            version,
            text,
            attachmentIds,
            now,
          );
        }
      }

      const after = await tx.announcement.update({
        where: { id },
        data: {
          ...settingsColumns(settings),
          ...audience,
          currentVersion: version,
          editedAt:
            version !== current.version && isOut(before, now)
              ? now
              : before.editedAt,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(after),
        'announcement.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'announcement.changed',
          targetId: id,
          changes,
        });
      if (version !== current.version)
        await this.audit.record(tx, {
          action: 'announcement.edited',
          targetId: id,
          metadata: { version, afterPublication: isOut(before, now) },
        });
      // Made important while out: its audience is told now.
      await this.announce(tx, after, now);
    });
  }

  /**
   * Publishes a draft, or moves a scheduled one: now, or at `publishAt`. A
   * date that has passed means now. What is already out stays out; taking
   * it down is `archive`.
   */
  publish(id: string, publishAt: Date | undefined): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = statusOf(before, now);
      if (status !== 'draft' && status !== 'scheduled')
        throw wrongState(status);
      const at = publishAt && publishAt > now ? publishAt : now;
      // It would come out already over.
      const end = before.worksEndsAt ?? before.expiresAt;
      if (end && end <= at)
        throw invalid([
          { field: 'publishAt', code: FieldErrorCode.ENDS_BEFORE_START },
        ]);
      const after = await tx.announcement.update({
        where: { id },
        data: { publishAt: at },
      });
      await this.audit.record(tx, {
        action: 'announcement.published',
        targetId: id,
        metadata: {
          publishAt: at.toISOString(),
          scheduled: at > now,
          fromStatus: status,
        },
      });
      await this.announce(tx, after, now);
    });
  }

  /** Takes it down for good. An announcement is never deleted. */
  archive(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = statusOf(before, now);
      if (status === 'archived') throw wrongState(status);
      await tx.announcement.update({
        where: { id },
        data: { archivedAt: now },
      });
      await this.audit.record(tx, {
        action: 'announcement.archived',
        targetId: id,
        metadata: { fromStatus: status },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Telling the audience
  // --------------------------------------------------------------------------

  /**
   * An important announcement that is out tells its audience, once: the
   * people in it at that moment. Whoever arrives later reads it in the
   * feed and is not told. Params: none; the announcement is the target.
   */
  private async announce(
    tx: TenantTxClient,
    a: Announcement,
    now: Date,
  ): Promise<number> {
    if (a.priority !== 'important' || a.notifiedAt || !isOut(a, now)) return 0;
    const members = await this.community.members(tx, audienceOf(a));
    const recipients = [...new Set(members.map((m) => m.accountId))];
    await this.notifier.notify(tx, recipients, {
      kind: 'community_announcement.important',
      params: {},
      targetId: a.id,
    });
    await tx.announcement.update({
      where: { id: a.id },
      data: { notifiedAt: now },
    });
    await this.audit.record(tx, {
      action: 'announcement.announced',
      targetId: a.id,
      metadata: { recipients: recipients.length },
    });
    return 1;
  }

  /**
   * The sweep: scheduled important announcements whose time has come. One
   * transaction per announcement, taken with SKIP LOCKED and judged again
   * under its lock, so run twice or on two instances an audience is told
   * once.
   */
  announceDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.announcement.findMany({
          where: {
            priority: 'important',
            notifiedAt: null,
            ...outWhere(now),
          },
          orderBy: [{ publishAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_BATCH,
          select: { id: true },
        });
        return due.map((a) => a.id);
      },
      async (tx, _tenantId, id) => {
        const [claimed] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM announcements
           WHERE id = ${id}::uuid AND notified_at IS NULL
             FOR UPDATE SKIP LOCKED`;
        if (!claimed) return 0;
        const a = await tx.announcement.findUniqueOrThrow({ where: { id } });
        return this.announce(tx, a, now);
      },
    );
  }

  // --------------------------------------------------------------------------
  // Reading (staff)
  // --------------------------------------------------------------------------

  /** Every announcement of the compound, the newest first. */
  listForStaff(q: StaffAnnouncementsQuery): Promise<Page<AnnouncementRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const where: Prisma.AnnouncementWhereInput = {
        AND: [
          q.kind ? { kind: q.kind } : {},
          q.status ? statusWhere(q.status, now) : {},
          ...byCreation.after(q.cursor),
        ],
      };
      const rows = await tx.announcement.findMany({
        where,
        orderBy: byCreation.orderBy,
        take: q.limit + 1,
      });
      const page = byCreation.toPage(rows, q.limit);
      return { ...page, items: await this.reads(tx, page.items, now, null) };
    });
  }

  getForStaff(id: string): Promise<AnnouncementRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const a = await tx.announcement.findUnique({ where: { id } });
      if (!a) throw announcementNotFound();
      return this.detail(tx, a, await dbNow(tx), null);
    });
  }

  /** What it said, the oldest version first, each with the files it showed. */
  versions(id: string): Promise<VersionRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const a = await tx.announcement.findUnique({ where: { id } });
      if (!a) throw announcementNotFound();
      const versions = await tx.announcementVersion.findMany({
        where: { announcementId: id },
        orderBy: { version: 'asc' },
      });
      const out: VersionRead[] = [];
      for (const version of versions)
        out.push({
          version,
          attachments: await this.attachmentsOf(tx, version),
        });
      return out;
    });
  }

  /**
   * How many opened it: accounts, and units. Counts only; there is nothing
   * stored that a list of readers could be read from.
   */
  readCounts(id: string): Promise<ReadCounts> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const a = await tx.announcement.findUnique({ where: { id } });
      if (!a) throw announcementNotFound();
      const marks = await tx.announcementReadMark.groupBy({
        by: ['kind'],
        where: { announcementId: id },
        _count: { _all: true },
      });
      const count = (kind: 'account' | 'unit') =>
        marks.find((m) => m.kind === kind)?._count._all ?? 0;
      const members = await this.community.members(tx, audienceOf(a));
      return {
        accounts: count('account'),
        units: count('unit'),
        audienceAccounts: new Set(members.map((m) => m.accountId)).size,
        audienceUnits: new Set(members.map((m) => m.unitId)).size,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Reading (residents)
  // --------------------------------------------------------------------------

  /**
   * What is out and put to the caller now, the most recently published
   * first. `pinned` keeps only what is pinned now.
   */
  feed(q: AnnouncementsQuery): Promise<Page<AnnouncementRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const places = await this.community.places(tx, me);
      const where: Prisma.AnnouncementWhereInput = {
        AND: [
          outWhere(now),
          audienceWhere(places),
          q.kind ? { kind: q.kind } : {},
          q.pinned ? { priority: 'important', pinnedUntil: { gt: now } } : {},
          ...byPublication.after(q.cursor),
        ],
      };
      const rows = (await tx.announcement.findMany({
        where,
        orderBy: byPublication.orderBy,
        take: q.limit + 1,
      })) as (Announcement & { publishAt: Date })[];
      const page = byPublication.toPage(rows, q.limit);
      return { ...page, items: await this.reads(tx, page.items, now, me) };
    });
  }

  /**
   * One announcement, if it is out and put to the caller. Unknown, another
   * compound's, not out or not for them: one answer.
   */
  one(id: string): Promise<AnnouncementRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const a = await this.visible(tx, id, me, now);
      return this.detail(tx, a.announcement, now, me);
    });
  }

  /**
   * The caller opened it. Leaves one mark for the account and one for each
   * of its units the announcement is put to; marking twice changes nothing.
   * Not audited, on purpose: an audit row would be the list of readers this
   * design does not keep.
   */
  markRead(id: string): Promise<void> {
    const me = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const { announcement, places } = await this.visible(tx, id, me, now);
      await tx.announcementReadMark.createMany({
        data: [
          {
            kind: 'account' as const,
            ref: this.refs.readMark('account', id, me),
          },
          ...placesIn(places, announcement).map((p) => ({
            kind: 'unit' as const,
            ref: this.refs.readMark('unit', id, p.unitId),
          })),
        ].map((mark) => ({ tenantId, announcementId: id, ...mark })),
        skipDuplicates: true,
      });
    });
  }

  /**
   * What the daily brief shows of the announcements (ADR 0040): what is
   * pinned, and what came out in the last `newDays` days that the caller
   * has not opened. Inside the brief's transaction.
   */
  async forBrief(
    tx: TenantTxClient,
    accountId: string,
    now: Date,
    newSince: Date,
  ): Promise<{
    pinned: AnnouncementRead[];
    fresh: AnnouncementRead[];
    works: AnnouncementRead[];
  }> {
    const places = await this.community.places(tx, accountId);
    const rows = await tx.announcement.findMany({
      where: {
        AND: [
          outWhere(now),
          audienceWhere(places),
          {
            OR: [
              { priority: 'important', pinnedUntil: { gt: now } },
              { publishAt: { gt: newSince } },
              { worksStartsAt: { lte: now } },
            ],
          },
        ],
      },
      orderBy: byPublication.orderBy,
      take: SWEEP_BATCH,
    });
    const reads = await this.reads(tx, rows, now, accountId);
    return {
      pinned: reads.filter((r) => r.pinned),
      fresh: reads.filter(
        (r) =>
          !r.pinned &&
          r.announcement.kind === 'general' &&
          r.read === false &&
          r.announcement.publishAt! > newSince,
      ),
      works: reads.filter((r) => r.worksActive),
    };
  }

  // --------------------------------------------------------------------------
  // Pieces
  // --------------------------------------------------------------------------

  /** The row under its lock: two writers go one after the other. */
  private async locked(tx: TenantTxClient, id: string): Promise<Announcement> {
    await tx.$queryRaw`SELECT id FROM announcements WHERE id = ${id}::uuid FOR UPDATE`;
    const a = await tx.announcement.findUnique({ where: { id } });
    if (!a) throw announcementNotFound();
    return a;
  }

  private async visible(
    tx: TenantTxClient,
    id: string,
    accountId: string,
    now: Date,
  ) {
    const announcement = await tx.announcement.findUnique({ where: { id } });
    const places = await this.community.places(tx, accountId);
    if (
      !announcement ||
      !isOut(announcement, now) ||
      !sees(places, announcement)
    )
      throw announcementNotFound();
    return { announcement, places };
  }

  private versionOf(
    tx: TenantTxClient,
    a: Pick<Announcement, 'id' | 'tenantId' | 'currentVersion'>,
  ): Promise<AnnouncementVersion> {
    return tx.announcementVersion.findUniqueOrThrow({
      where: {
        tenantId_announcementId_version: {
          tenantId: a.tenantId,
          announcementId: a.id,
          version: a.currentVersion,
        },
      },
    });
  }

  private async writeVersion(
    tx: TenantTxClient,
    a: Pick<Announcement, 'id' | 'tenantId'>,
    version: number,
    text: Localized,
    attachmentIds: string[],
    now: Date,
  ): Promise<void> {
    await tx.announcementVersion.create({
      data: {
        id: newId(),
        tenantId: a.tenantId,
        announcementId: a.id,
        version,
        titleEn: text.titleEn,
        bodyEn: text.bodyEn,
        titleAr: text.titleAr,
        bodyAr: text.bodyAr,
        attachmentIds,
        editedById: this.ctx.accountId,
        createdAt: now,
      },
    });
  }

  /** One of the caller's files becomes the announcement's; its attachment id. */
  private async attach(
    tx: TenantTxClient,
    a: Pick<Announcement, 'id' | 'tenantId'>,
    fileId: string,
    index: number,
    now: Date,
  ): Promise<string> {
    const file = await this.attachments.take(
      tx,
      fileId,
      `attachmentFileIds.${index}`,
    );
    const row = await tx.announcementAttachment.create({
      data: {
        id: newId(),
        tenantId: a.tenantId,
        announcementId: a.id,
        fileId: file.id,
        uploadedById: this.ctx.accountId,
        createdAt: now,
      },
    });
    return row.id;
  }

  /**
   * The files the next version shows: each id is one the current version
   * already shows (kept) or one of the caller's own uploads (attached now).
   */
  private async attachmentSet(
    tx: TenantTxClient,
    a: Announcement,
    current: AnnouncementVersion,
    ids: readonly string[],
    now: Date,
  ): Promise<string[]> {
    const wanted = this.attachments.ids(ids, 'attachmentFileIds');
    const out: string[] = [];
    for (const [i, id] of wanted.entries())
      out.push(
        current.attachmentIds.includes(id)
          ? id
          : await this.attach(tx, a, id, i, now),
      );
    return out;
  }

  private async attachmentsOf(
    tx: TenantTxClient,
    version: AnnouncementVersion,
  ): Promise<AttachmentRead[]> {
    if (!version.attachmentIds.length) return [];
    const rows = await tx.announcementAttachment.findMany({
      where: { id: { in: version.attachmentIds } },
      include: { file: { select: { contentType: true } } },
    });
    // In the order the version lists them.
    const ordered = version.attachmentIds.flatMap(
      (id) => rows.find((r) => r.id === id) ?? [],
    );
    return this.attachments.read(tx, ordered);
  }

  private async requireGate(tx: TenantTxClient, s: Settings): Promise<void> {
    const gateId = s.works?.gateId;
    if (gateId && !(await this.gates.exists(tx, gateId)))
      throw invalid([
        { field: 'works.gateId', code: FieldErrorCode.INVALID_VALUE },
      ]);
  }

  /** Rows as reads, without their files. `reader`: whose "read" to tell. */
  private async reads(
    tx: TenantTxClient,
    rows: readonly Announcement[],
    now: Date,
    reader: string | null,
  ): Promise<AnnouncementRead[]> {
    if (!rows.length) return [];
    const versions = await tx.announcementVersion.findMany({
      where: {
        OR: rows.map((a) => ({
          announcementId: a.id,
          version: a.currentVersion,
        })),
      },
    });
    const gates = rows.some((a) => a.worksGateId)
      ? await this.gates.statuses(tx)
      : [];
    const opened = reader ? await this.openedBy(tx, rows, reader) : null;
    return rows.map((announcement) => ({
      announcement,
      version: versions.find((v) => v.announcementId === announcement.id)!,
      status: statusOf(announcement, now),
      pinned: isPinned(announcement, now),
      worksActive: worksActive(announcement, now),
      gate: gates.find((g) => g.id === announcement.worksGateId) ?? null,
      attachments: null,
      read: opened ? opened.has(announcement.id) : null,
    }));
  }

  private async detail(
    tx: TenantTxClient,
    a: Announcement,
    now: Date,
    reader: string | null,
  ): Promise<AnnouncementRead> {
    const [read] = await this.reads(tx, [a], now, reader);
    return { ...read, attachments: await this.attachmentsOf(tx, read.version) };
  }

  /**
   * Which of the announcements the account has opened: its own mark is
   * derived again and looked up. Only the reader's own.
   */
  private async openedBy(
    tx: TenantTxClient,
    rows: readonly Announcement[],
    accountId: string,
  ): Promise<Set<string>> {
    const refs = new Map(
      rows.map((a) => [a.id, this.refs.readMark('account', a.id, accountId)]),
    );
    const marks = await tx.announcementReadMark.findMany({
      where: {
        kind: 'account',
        announcementId: { in: [...refs.keys()] },
        ref: { in: [...refs.values()] },
      },
      select: { announcementId: true, ref: true },
    });
    return new Set(
      marks
        .filter((m) => {
          const own = refs.get(m.announcementId);
          return own !== undefined && sameRef(own, m.ref);
        })
        .map((m) => m.announcementId),
    );
  }
}

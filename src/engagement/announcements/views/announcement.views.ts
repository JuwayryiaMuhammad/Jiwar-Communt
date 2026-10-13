import { ApiProperty } from '@nestjs/swagger';
import {
  AnnouncementKind,
  AnnouncementPriority,
  WorksAreaKind,
  type Announcement,
  type AnnouncementVersion,
} from '@prisma/client';
import { AudienceView } from '../../audience/audience';
import { CommunityAttachmentView } from '../../content/attachment.view';
import {
  ANNOUNCEMENT_STATUSES,
  type AnnouncementRead,
  type ReadCounts,
  type VersionRead,
} from '../announcements.service';
import type { AnnouncementStatus } from '../announcement-rules';

export class AnnouncementCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No text: the stored replay of a create holds none. */
  static from(
    a: Pick<Announcement, 'id' | 'createdAt'>,
  ): AnnouncementCreatedView {
    return { id: a.id, createdAt: a.createdAt };
  }
}

/** The gate works are at, as an occupant sees a gate. */
export class WorksGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  name: string;
  @ApiProperty({ type: Boolean, description: 'In service now.' })
  open: boolean;
}

/** Where works are and when. */
export class WorksView {
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: WorksAreaKind, enumName: 'WorksAreaKind' })
  areaKind: WorksAreaKind;
  @ApiProperty({ type: WorksGateView, nullable: true })
  gate: WorksGateView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Where, in the staff’s words.',
  })
  place: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Under way now: started and not ended.',
  })
  active: boolean;

  static from(r: AnnouncementRead): WorksView | null {
    const a = r.announcement;
    if (a.kind !== 'works') return null;
    return {
      startsAt: a.worksStartsAt!,
      endsAt: a.worksEndsAt!,
      areaKind: a.worksAreaKind!,
      gate: r.gate
        ? { id: r.gate.id, name: r.gate.name, open: r.gate.open }
        : null,
      place: a.worksPlace,
      active: r.worksActive,
    };
  }
}

class AnnouncementTextView {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Written by the staff. A language is whole or absent; at least one is there.',
  })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyAr: string | null;
}

const textOf = (v: AnnouncementVersion): AnnouncementTextView => ({
  titleEn: v.titleEn,
  bodyEn: v.bodyEn,
  titleAr: v.titleAr,
  bodyAr: v.bodyAr,
});

/** An announcement in the resident's feed: what is out and put to them now. */
export class AnnouncementListItemView extends AnnouncementTextView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: AnnouncementKind, enumName: 'AnnouncementKind' })
  kind: AnnouncementKind;
  @ApiProperty({ enum: AnnouncementPriority, enumName: 'AnnouncementPriority' })
  priority: AnnouncementPriority;
  @ApiProperty({ type: Boolean, description: 'Pinned now.' })
  pinned: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When it was last edited after it came out. Null: never.',
  })
  editedAt: Date | null;
  @ApiProperty({ type: WorksView, nullable: true })
  works: WorksView | null;
  @ApiProperty({ type: Number, description: 'Files it shows.' })
  attachmentCount: number;
  @ApiProperty({ type: Boolean, description: 'The caller has opened it.' })
  read: boolean;

  static from(r: AnnouncementRead): AnnouncementListItemView {
    const a = r.announcement;
    return {
      id: a.id,
      kind: a.kind,
      priority: a.priority,
      pinned: r.pinned,
      publishedAt: a.publishAt!,
      expiresAt: a.expiresAt,
      editedAt: a.editedAt,
      ...textOf(r.version),
      works: WorksView.from(r),
      attachmentCount: r.version.attachmentIds.length,
      read: r.read === true,
    };
  }
}

export class AnnouncementView extends AnnouncementListItemView {
  @ApiProperty({ type: [CommunityAttachmentView] })
  attachments: CommunityAttachmentView[];

  static from(r: AnnouncementRead): AnnouncementView {
    return {
      ...AnnouncementListItemView.from(r),
      attachments: (r.attachments ?? []).map((a) =>
        CommunityAttachmentView.from(a),
      ),
    };
  }
}

/** An announcement as the staff see it: every state, its settings and its audience. */
export class StaffAnnouncementListItemView extends AnnouncementTextView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: AnnouncementKind, enumName: 'AnnouncementKind' })
  kind: AnnouncementKind;
  @ApiProperty({
    enum: ANNOUNCEMENT_STATUSES,
    description:
      'From its dates, now: `draft`, `scheduled`, `published`, `expired` (past its expiry), `ended` (works over) or `archived`.',
  })
  status: AnnouncementStatus;
  @ApiProperty({ enum: AnnouncementPriority, enumName: 'AnnouncementPriority' })
  priority: AnnouncementPriority;
  @ApiProperty({ type: Boolean, description: 'Pinned now.' })
  pinned: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pinnedUntil: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null: a draft.',
  })
  publishAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt: Date | null;
  @ApiProperty({ type: AudienceView })
  audience: AudienceView;
  @ApiProperty({ type: Number, description: 'The version it shows.' })
  version: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When its audience was told (important ones only).',
  })
  notifiedAt: Date | null;
  @ApiProperty({ type: WorksView, nullable: true })
  works: WorksView | null;
  @ApiProperty({ type: Number })
  attachmentCount: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: AnnouncementRead): StaffAnnouncementListItemView {
    const a = r.announcement;
    return {
      id: a.id,
      kind: a.kind,
      status: r.status,
      priority: a.priority,
      pinned: r.pinned,
      pinnedUntil: a.pinnedUntil,
      publishAt: a.publishAt,
      expiresAt: a.expiresAt,
      archivedAt: a.archivedAt,
      audience: AudienceView.from(a),
      version: a.currentVersion,
      editedAt: a.editedAt,
      notifiedAt: a.notifiedAt,
      ...textOf(r.version),
      works: WorksView.from(r),
      attachmentCount: r.version.attachmentIds.length,
      createdAt: a.createdAt,
    };
  }
}

export class StaffAnnouncementView extends StaffAnnouncementListItemView {
  @ApiProperty({ type: [CommunityAttachmentView] })
  attachments: CommunityAttachmentView[];

  static from(r: AnnouncementRead): StaffAnnouncementView {
    return {
      ...StaffAnnouncementListItemView.from(r),
      attachments: (r.attachments ?? []).map((a) =>
        CommunityAttachmentView.from(a),
      ),
    };
  }
}

/** What an announcement said at one version. */
export class AnnouncementVersionView extends AnnouncementTextView {
  @ApiProperty({ type: Number })
  version: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'uuid', description: 'Who wrote it.' })
  editedById: string;
  @ApiProperty({ type: [CommunityAttachmentView] })
  attachments: CommunityAttachmentView[];

  static from(r: VersionRead): AnnouncementVersionView {
    return {
      version: r.version.version,
      createdAt: r.version.createdAt,
      editedById: r.version.editedById,
      ...textOf(r.version),
      attachments: r.attachments.map((a) => CommunityAttachmentView.from(a)),
    };
  }
}

/** How many opened an announcement. Counts only: never who. */
export class AnnouncementReadCountsView {
  @ApiProperty({ type: Number, description: 'Accounts that opened it.' })
  accounts: number;
  @ApiProperty({
    type: Number,
    description: 'Units at least one of whose people opened it.',
  })
  units: number;
  @ApiProperty({
    type: Number,
    description: 'Accounts it is put to right now.',
  })
  audienceAccounts: number;
  @ApiProperty({ type: Number, description: 'Units it is put to right now.' })
  audienceUnits: number;

  static from(c: ReadCounts): AnnouncementReadCountsView {
    return {
      accounts: c.accounts,
      units: c.units,
      audienceAccounts: c.audienceAccounts,
      audienceUnits: c.audienceUnits,
    };
  }
}

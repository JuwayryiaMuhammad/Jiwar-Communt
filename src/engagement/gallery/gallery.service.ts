import { Injectable } from '@nestjs/common';
import type { GalleryAlbum, GalleryPhoto } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';

export const ALBUM_TITLE_LENGTH = { min: 1, max: 120 } as const;
export const CAPTION_LENGTH = { min: 1, max: 300 } as const;

export interface PhotoRead {
  photo: GalleryPhoto;
  contentType: string;
  read: PresignedRead | null;
  reports: number;
}

export interface AlbumRead {
  album: GalleryAlbum;
  photos: PhotoRead[];
}

const PAGE = keysetCursor('createdAt');

export const albumNotFound = () =>
  appError.notFound(ErrorCode.GALLERY_ALBUM_NOT_FOUND, 'Album not found');
export const photoNotFound = () =>
  appError.notFound(ErrorCode.GALLERY_PHOTO_NOT_FOUND, 'Photo not found');

/**
 * The gallery (ADR 0071): albums of photos the staff upload
 * (`content.manage`), residents see once published. A resident reports a
 * photo once; a privacy report hides it at once, pending the staff, who
 * restore it or keep it hidden with a code. A hidden photo is never shown
 * to a resident.
 *
 * Locks: the album's row (FOR UPDATE to publish or add, FOR SHARE to
 * report), then the photo's (FOR UPDATE): a report and a publication are
 * decided one at a time.
 */
@Injectable()
export class GalleryService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly files: FilesService,
    private readonly staff: StaffRecipients,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
  ) {}

  createAlbum(input: {
    titleEn: string;
    titleAr: string;
    eventId?: string;
  }): Promise<AlbumRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (
        input.eventId &&
        !(await tx.communityEvent.count({ where: { id: input.eventId } }))
      )
        throw appError.notFound(
          ErrorCode.COMMUNITY_EVENT_NOT_FOUND,
          'Event not found',
        );
      const album = await tx.galleryAlbum.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          titleEn: input.titleEn.trim(),
          titleAr: input.titleAr.trim(),
          eventId: input.eventId ?? null,
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'gallery_album.created',
        targetId: album.id,
        metadata: { eventId: album.eventId },
      });
      return { album, photos: [] };
    });
  }

  addPhoto(
    albumId: string,
    input: { fileId: string; caption?: string },
  ): Promise<PhotoRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockAlbum(tx, albumId, 'update');
      const file = await this.files.claim(tx, input.fileId, 'gallery_photo');
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid photo',
          {
            fields: [
              { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
            ],
          },
        );
      await this.files.attach(tx, file);
      const photo = await tx.galleryPhoto.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          albumId,
          fileId: file.id,
          caption: input.caption?.trim() || null,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'gallery_photo.added',
        targetId: photo.id,
        metadata: { albumId },
      });
      return (await this.photos(tx, [photo]))[0];
    });
  }

  publish(albumId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const album = await this.lockAlbum(tx, albumId, 'update');
      if (album.publishedAt)
        throw appError.conflict(
          ErrorCode.GALLERY_ALBUM_PUBLISHED,
          'The album is published already',
        );
      await tx.galleryAlbum.update({
        where: { id: albumId },
        data: { publishedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'gallery_album.published',
        targetId: albumId,
        metadata: {
          photos: await tx.galleryPhoto.count({ where: { albumId } }),
        },
      });
    });
  }

  /** The staff hide a photo with a code, or keep a reported one hidden. */
  hide(photoId: string, reasonCode: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.galleryPhotoHide,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const photo = await this.lockPhoto(tx, photoId);
      await tx.galleryPhoto.update({
        where: { id: photoId },
        data: {
          hiddenAt: photo.hiddenAt ?? (await dbNow(tx)),
          hiddenReason: code,
        },
      });
      await this.audit.record(tx, {
        action: 'gallery_photo.hidden',
        targetId: photoId,
        metadata: { reasonCode: code, by: 'staff' },
      });
    });
  }

  /** The staff show a hidden photo again. */
  restore(photoId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const photo = await this.lockPhoto(tx, photoId);
      if (!photo.hiddenAt) return;
      await tx.galleryPhoto.update({
        where: { id: photoId },
        data: { hiddenAt: null, hiddenReason: null },
      });
      await this.audit.record(tx, {
        action: 'gallery_photo.restored',
        targetId: photoId,
        metadata: { was: photo.hiddenReason },
      });
    });
  }

  /** Every album, drafts too, with every photo and how often it was reported. */
  staffList(q: { cursor?: string; limit?: number }): Promise<Page<AlbumRead>> {
    return this.page(q, {}, true);
  }

  /** The published albums, their visible photos only. */
  list(q: { cursor?: string; limit?: number }): Promise<Page<AlbumRead>> {
    return this.page(q, { publishedAt: { not: null } }, false);
  }

  get(albumId: string): Promise<AlbumRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const album = await tx.galleryAlbum.findUnique({
        where: { id: albumId },
      });
      if (!album || !album.publishedAt) throw albumNotFound();
      return this.read(tx, album, false);
    });
  }

  /**
   * A resident reports a photo of a published album, once. A privacy
   * report hides it at once; the staff are told either way.
   */
  report(photoId: string, reason: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(reason, REASON_CODES.galleryPhotoReport);
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.galleryPhoto.findUnique({
        where: { id: photoId },
        select: { albumId: true },
      });
      if (!found) throw photoNotFound();
      const album = await this.lockAlbum(tx, found.albumId, 'share');
      const photo = await this.lockPhoto(tx, photoId);
      if (!album.publishedAt || photo.hiddenAt) throw photoNotFound();
      if (
        await tx.galleryPhotoReport.count({
          where: { photoId, reporterId: this.ctx.accountId },
        })
      )
        throw appError.conflict(
          ErrorCode.GALLERY_REPORT_EXISTS,
          'You reported this photo already',
        );
      const now = await dbNow(tx);
      await tx.galleryPhotoReport.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          photoId,
          reporterId: this.ctx.accountId,
          reason: code,
          createdAt: now,
        },
      });
      if (code === 'privacy') {
        await tx.galleryPhoto.update({
          where: { id: photoId },
          data: { hiddenAt: now, hiddenReason: 'privacy_report' },
        });
        await this.audit.record(tx, {
          action: 'gallery_photo.hidden',
          targetId: photoId,
          metadata: { reasonCode: 'privacy_report', by: 'report' },
        });
      }
      await this.audit.record(tx, {
        action: 'gallery_photo.reported',
        targetId: photoId,
        metadata: { reason: code },
      });
      const handlers = await this.staff.holding(tx, 'content.manage');
      await this.notifier.notify(
        tx,
        handlers.map((h) => h.id),
        {
          kind: 'gallery_photo.reported',
          params: { reason: code },
          targetId: photoId,
        },
      );
    });
  }

  private async page(
    q: { cursor?: string; limit?: number },
    where: { publishedAt?: { not: null } },
    staff: boolean,
  ): Promise<Page<AlbumRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.galleryAlbum.findMany({
        where: { AND: [where, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: AlbumRead[] = [];
      for (const album of page.items)
        items.push(await this.read(tx, album, staff));
      return { items, nextCursor: page.nextCursor };
    });
  }

  private async read(
    tx: TenantTxClient,
    album: GalleryAlbum,
    staff: boolean,
  ): Promise<AlbumRead> {
    const photos = await tx.galleryPhoto.findMany({
      where: { albumId: album.id, ...(staff ? {} : { hiddenAt: null }) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { album, photos: await this.photos(tx, photos) };
  }

  private async photos(
    tx: TenantTxClient,
    photos: readonly GalleryPhoto[],
  ): Promise<PhotoRead[]> {
    const out: PhotoRead[] = [];
    for (const photo of photos) {
      const file = await tx.storedFile.findUniqueOrThrow({
        where: { id: photo.fileId },
        select: { contentType: true },
      });
      out.push({
        photo,
        contentType: file.contentType,
        read: await this.files.readUrl(tx, photo.fileId),
        reports: await tx.galleryPhotoReport.count({
          where: { photoId: photo.id },
        }),
      });
    }
    return out;
  }

  private async lockAlbum(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<GalleryAlbum> {
    if (mode === 'share')
      await tx.$queryRaw`SELECT id FROM gallery_albums WHERE id = ${id}::uuid FOR SHARE`;
    else
      await tx.$queryRaw`SELECT id FROM gallery_albums WHERE id = ${id}::uuid FOR UPDATE`;
    const album = await tx.galleryAlbum.findUnique({ where: { id } });
    if (!album) throw albumNotFound();
    return album;
  }

  private async lockPhoto(
    tx: TenantTxClient,
    id: string,
  ): Promise<GalleryPhoto> {
    await tx.$queryRaw`SELECT id FROM gallery_photos WHERE id = ${id}::uuid FOR UPDATE`;
    const photo = await tx.galleryPhoto.findUnique({ where: { id } });
    if (!photo) throw photoNotFound();
    return photo;
  }
}

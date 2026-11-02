import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
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
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';
import { fraction, units } from './fractions';

export const MAP_POINT_KINDS = ['building', 'gate', 'facility'] as const;
export type MapPointKind = (typeof MAP_POINT_KINDS)[number];
/** Points on one map, at most. */
export const MAX_MAP_POINTS = 500;

export interface MapPointInput {
  kind: MapPointKind;
  refId: string;
  x: number;
  y: number;
}

export interface MapPointRead {
  id: string;
  kind: MapPointKind;
  refId: string;
  nameEn: string;
  nameAr: string;
  x: number;
  y: number;
}

export interface SiteMapRead {
  image: PresignedRead | null;
  points: MapPointRead[];
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/**
 * The compound's site map (ADR 0084): one image (purpose `site_map`) and a
 * point each for its buildings (ADR 0072), gates and facilities, kept with
 * `spaces.manage`. Every write takes the map's advisory lock (there may be
 * no row yet), after the caller's account: two first images, or a new image
 * and new points, go one after the other. A replaced image's file is marked
 * deleted (`replaced`); the points stay where they were, as fractions.
 */
@Injectable()
export class SiteMapService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FacilitiesAccess,
    private readonly files: FilesService,
  ) {}

  /**
   * The map as the staff see it, or (`residents`) as the apps do: there,
   * only active facilities and active gates.
   */
  read(audience: 'staff' | 'residents'): Promise<SiteMapRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const map = await tx.siteMap.findUnique({
        where: { tenantId: this.ctx.tenantId },
      });
      if (!map) return { image: null, points: [] };
      const points = await this.points(tx);
      return {
        image: await this.files.readUrl(tx, map.fileId),
        points:
          audience === 'staff'
            ? points.map((p) => p.read)
            : points.filter((p) => p.live).map((p) => p.read),
      };
    });
  }

  setImage(fileId: string): Promise<SiteMapRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockMap(tx);
      const file = await this.files.claim(tx, fileId, 'site_map');
      if (!file)
        throw invalid([
          { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const tenantId = this.ctx.tenantId;
      const before = await tx.siteMap.findUnique({ where: { tenantId } });
      if (before) {
        await tx.siteMap.update({
          where: { tenantId },
          data: { fileId: file.id },
        });
        await this.files.markDeleted(
          tx,
          { id: before.fileId, purpose: 'site_map' },
          'replaced',
        );
      } else await tx.siteMap.create({ data: { tenantId, fileId: file.id } });
      await this.audit.record(tx, {
        action: 'site_map.image_set',
        targetId: tenantId,
        metadata: {
          fileId: file.id,
          ...(before ? { replacedFileId: before.fileId } : {}),
        },
      });
      return {
        image: await this.files.readUrl(tx, file.id),
        points: (await this.points(tx)).map((p) => p.read),
      };
    });
  }

  /**
   * Replaces every point at once. Each place once (DUPLICATE_VALUE), one of
   * the compound's (MAP_PLACE_NOT_AVAILABLE: a building of the register, a
   * gate, a facility that is active); inside the image by the DTO's range.
   */
  setPoints(input: readonly MapPointInput[]): Promise<SiteMapRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.lockMap(tx);
      const tenantId = this.ctx.tenantId;
      const map = await tx.siteMap.findUnique({ where: { tenantId } });
      if (!map)
        throw appError.conflict(
          ErrorCode.SITE_MAP_NOT_SET,
          'Set the site map’s image first',
        );
      const fields: FieldError[] = [];
      const seen = new Set<string>();
      const known = await this.knownPlaces(tx, input);
      input.forEach((p, i) => {
        const key = `${p.kind}:${p.refId}`;
        if (seen.has(key))
          fields.push({
            field: `points.${i}.refId`,
            code: FieldErrorCode.DUPLICATE_VALUE,
          });
        else if (!known.has(key))
          fields.push({
            field: `points.${i}.refId`,
            code: FieldErrorCode.MAP_PLACE_NOT_AVAILABLE,
          });
        seen.add(key);
      });
      if (fields.length) throw invalid(fields);
      const now = await dbNow(tx);
      await tx.siteMapPoint.deleteMany({});
      if (input.length)
        await tx.siteMapPoint.createMany({
          data: input.map((p) => ({
            id: newId(),
            tenantId,
            kind: p.kind,
            buildingId: p.kind === 'building' ? p.refId : null,
            gateId: p.kind === 'gate' ? p.refId : null,
            facilityId: p.kind === 'facility' ? p.refId : null,
            x: fraction(units(p.x)),
            y: fraction(units(p.y)),
            createdAt: now,
          })),
        });
      const count = (k: MapPointKind) =>
        input.filter((p) => p.kind === k).length;
      await this.audit.record(tx, {
        action: 'site_map.points_set',
        targetId: tenantId,
        metadata: {
          buildings: count('building'),
          gates: count('gate'),
          facilities: count('facility'),
        },
      });
      return {
        image: await this.files.readUrl(tx, map.fileId),
        points: (await this.points(tx)).map((p) => p.read),
      };
    });
  }

  private async lockMap(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`site-map:${this.ctx.txTenantId}`}))`;
  }

  /** The places of the input that are the compound's, as `kind:id`. */
  private async knownPlaces(
    tx: TenantTxClient,
    input: readonly MapPointInput[],
  ): Promise<Set<string>> {
    const ids = (k: MapPointKind) => [
      ...new Set(input.filter((p) => p.kind === k).map((p) => p.refId)),
    ];
    const buildings = await tx.building.findMany({
      where: { id: { in: ids('building') } },
      select: { id: true },
    });
    const gates = await tx.gate.findMany({
      where: { id: { in: ids('gate') } },
      select: { id: true },
    });
    const facilities = await tx.facility.findMany({
      where: { id: { in: ids('facility') }, active: true },
      select: { id: true },
    });
    return new Set([
      ...buildings.map((b) => `building:${b.id}`),
      ...gates.map((g) => `gate:${g.id}`),
      ...facilities.map((f) => `facility:${f.id}`),
    ]);
  }

  /** The points with their places' names; `live` for the apps' view. */
  private async points(
    tx: TenantTxClient,
  ): Promise<{ read: MapPointRead; live: boolean }[]> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        kind: MapPointKind;
        ref_id: string;
        name_en: string;
        name_ar: string;
        live: boolean;
        x: string;
        y: string;
      }[]
    >`
      SELECT p.id, p.kind,
             COALESCE(p.building_id, p.gate_id, p.facility_id) AS ref_id,
             COALESCE(b.name, g.name, f.name_en) AS name_en,
             COALESCE(b.name, g.name, f.name_ar) AS name_ar,
             (p.kind = 'building'
              OR (p.kind = 'gate' AND g.status::text = 'active')
              OR (p.kind = 'facility' AND f.active)) AS live,
             p.x::text AS x, p.y::text AS y
        FROM site_map_points p
        LEFT JOIN buildings b ON b.id = p.building_id
        LEFT JOIN gates g ON g.id = p.gate_id
        LEFT JOIN facilities f ON f.id = p.facility_id
       ORDER BY p.kind, name_en, p.id`;
    return rows.map((r) => ({
      live: r.live,
      read: {
        id: r.id,
        kind: r.kind,
        refId: r.ref_id,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        x: Number(r.x),
        y: Number(r.y),
      },
    }));
  }
}

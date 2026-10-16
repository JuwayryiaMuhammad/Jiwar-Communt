import { Injectable } from '@nestjs/common';
import type { PatrolCheckpoint } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { RosterCore } from '../roster/roster-core';
import { issueCheckpointSecret } from './checkpoint-tokens';
import { DEFAULT_RADIUS_M } from './patrol-rules';
import { CheckpointSecretView, CheckpointView } from './views/checkpoint.views';

const CURSOR = keysetCursor('createdAt');

export const checkpointNotFound = () =>
  appError.notFound(
    ErrorCode.PATROL_CHECKPOINT_NOT_FOUND,
    'Checkpoint not found',
  );
const retired = () =>
  appError.conflict(
    ErrorCode.PATROL_CHECKPOINT_RETIRED,
    'The checkpoint is retired',
  );

export interface CheckpointPosition {
  lat: number;
  lng: number;
  radiusM?: number;
}

/** What the audit sees of a checkpoint: its post and state; names and position as changed. */
function audited(c: PatrolCheckpoint) {
  return {
    gateId: c.gateId,
    placeId: c.placeId,
    nameEn: c.nameEn,
    nameAr: c.nameAr,
    lat: c.lat,
    lng: c.lng,
    radiusM: c.radiusM,
  };
}

function positionOf(p: CheckpointPosition | null | undefined) {
  return p
    ? { lat: p.lat, lng: p.lng, radiusM: p.radiusM ?? DEFAULT_RADIUS_M }
    : { lat: null, lng: null, radiusM: null };
}

/**
 * The checkpoints a patrol scans (ADR 0052), kept by `patrols.manage`. A
 * checkpoint is at a post (a gate, or a zone) and may have a position.
 * Its QR and NFC tag carry `JWK1.<id>.<token>`: the payload is answered
 * once, at creation and at a reissue, and only the token's hash is kept.
 * A reissue takes the row FOR UPDATE and replaces the hash, so a scan
 * holding it FOR SHARE checked the old token before, or meets the new one.
 * Two checkpoints in service never share a name (409 DUPLICATE_RESOURCE).
 * Retired, never deleted.
 */
@Injectable()
export class CheckpointsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly roster: RosterCore,
    private readonly names: DutyNamesReader,
  ) {}

  /** No `Idempotency-Key`: a retry meets the unique name, and the payload is never stored. */
  create(input: {
    gateId?: string;
    zoneId?: string;
    nameEn: string;
    nameAr: string;
    position?: CheckpointPosition | null;
  }): Promise<CheckpointSecretView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const post = await this.roster.requirePost(tx, input);
      const id = newId();
      const secret = issueCheckpointSecret(this.ctx.txTenantId, id);
      const checkpoint = await tx.patrolCheckpoint.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          gateId: post.gateId,
          placeId: post.placeId,
          nameEn: input.nameEn.trim(),
          nameAr: input.nameAr.trim(),
          ...positionOf(input.position),
          tokenHash: secret.tokenHash,
          tokenIssuedAt: await dbNow(tx),
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'patrol_checkpoint.created',
        targetId: id,
        changes: diffChanges(
          null,
          audited(checkpoint),
          'patrol_checkpoint.created',
        ),
      });
      return {
        ...(await this.view(tx, checkpoint)),
        qrPayload: secret.qrPayload,
      };
    });
  }

  /** Names and position, while in service. `position: null` removes it. */
  update(
    id: string,
    input: {
      nameEn?: string;
      nameAr?: string;
      position?: CheckpointPosition | null;
    },
  ): Promise<CheckpointView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.retiredAt) throw retired();
      const checkpoint = await tx.patrolCheckpoint.update({
        where: { id },
        data: {
          nameEn: input.nameEn?.trim(),
          nameAr: input.nameAr?.trim(),
          ...(input.position === undefined ? {} : positionOf(input.position)),
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(checkpoint),
        'patrol_checkpoint.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'patrol_checkpoint.updated',
          targetId: id,
          changes,
        });
      return this.view(tx, checkpoint);
    });
  }

  /**
   * A new token: the old printout stops scanning in this transaction. The
   * row is taken FOR UPDATE, so a scan verifying the old token under its
   * share lock finished before.
   */
  reissue(id: string): Promise<CheckpointSecretView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.retiredAt) throw retired();
      const secret = issueCheckpointSecret(this.ctx.txTenantId, id);
      const now = await dbNow(tx);
      const checkpoint = await tx.patrolCheckpoint.update({
        where: { id },
        data: {
          tokenHash: secret.tokenHash,
          // Later than the last one, whatever the clock's resolution.
          tokenIssuedAt:
            now > before.tokenIssuedAt
              ? now
              : new Date(before.tokenIssuedAt.getTime() + 1),
        },
      });
      await this.audit.record(tx, {
        action: 'patrol_checkpoint.token_reissued',
        targetId: id,
      });
      return {
        ...(await this.view(tx, checkpoint)),
        qrPayload: secret.qrPayload,
      };
    });
  }

  /** Retired once, never brought back: its scans stay. */
  retire(id: string): Promise<CheckpointView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.retiredAt) throw retired();
      const checkpoint = await tx.patrolCheckpoint.update({
        where: { id },
        data: {
          retiredAt: await dbNow(tx),
          retiredById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'patrol_checkpoint.retired',
        targetId: id,
      });
      return this.view(tx, checkpoint);
    });
  }

  list(q: {
    status?: 'active' | 'retired';
    gateId?: string;
    zoneId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<CheckpointView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.patrolCheckpoint.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            ...(q.status === 'active' ? [{ retiredAt: null }] : []),
            ...(q.status === 'retired' ? [{ retiredAt: { not: null } }] : []),
            ...(q.gateId ? [{ gateId: q.gateId }] : []),
            ...(q.zoneId ? [{ placeId: q.zoneId }] : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      return {
        items: await this.views(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** The checkpoint FOR UPDATE, or 404. */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<PatrolCheckpoint> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_checkpoints WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw checkpointNotFound();
    return tx.patrolCheckpoint.findUniqueOrThrow({ where: { id } });
  }

  private async views(
    tx: TenantTxClient,
    rows: readonly PatrolCheckpoint[],
  ): Promise<CheckpointView[]> {
    const names = await this.names.read(tx, [], rows);
    return rows.map((c) => CheckpointView.of(c, names));
  }

  private async view(
    tx: TenantTxClient,
    row: PatrolCheckpoint,
  ): Promise<CheckpointView> {
    return (await this.views(tx, [row]))[0];
  }
}

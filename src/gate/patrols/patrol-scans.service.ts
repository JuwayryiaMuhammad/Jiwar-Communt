import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PatrolNote,
  type PatrolRun,
  type PatrolScan,
} from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import {
  checkpointTokenMatches,
  parseCheckpointPayload,
} from './checkpoint-tokens';
import { runNotFound } from './guard-patrols.service';
import { GateMedia, PATROL_NOTE_MEDIA } from '../media/gate-media';
import { PatrolCore } from './patrol-core';
import {
  distanceMetres,
  inRunLifetime,
  MAX_NOTE_MEDIA,
  MAX_NOTE_PHOTOS,
  NOTE_AFTER_END_MINUTES,
  NOTE_TEXT,
  orderProblem,
} from './patrol-rules';
import { RunsCore } from './runs-core';
import { NoteView, ScanView } from './views/scan.views';

const MINUTE = 60_000;

export interface ScanInput {
  id: string;
  method: 'qr' | 'nfc' | 'manual';
  payload?: string;
  checkpointId?: string;
  reasonCode?: string;
  scannedAt: Date;
  lat?: number;
  lng?: number;
  accuracyM?: number;
}

export interface NoteInput {
  id: string;
  scanId: string;
  outcome: 'all_clear' | 'issue_found';
  text?: string;
  notedAt: Date;
  photoFileIds?: string[];
  mediaFileIds?: string[];
}

const invalidCheckpoint = () =>
  appError.unprocessable(
    ErrorCode.PATROL_CHECKPOINT_INVALID,
    'Not a checkpoint of this compound',
  );
const idUsed = () =>
  appError.conflict(
    ErrorCode.IDEMPOTENCY_CONFLICT,
    'This id was used for something else',
  );
const outOfWindow = (field: string) =>
  appError.unprocessable(
    ErrorCode.PATROL_SCAN_OUT_OF_WINDOW,
    'Outside the run’s lifetime',
    { params: { field } },
  );

/**
 * What a guard records during their run (ADR 0052): scans and notes.
 *
 * - **Offline-ready.** Each carries the app's own UUIDv7 and the device's
 *   time: the same id again answers the same (another content is 409
 *   IDEMPOTENCY_CONFLICT), and the time must fall in the run's lifetime,
 *   two minutes either side. The server keeps when it received it too. A
 *   scan arriving after its run ended is recorded; the run's status stays.
 * - **Serialized by the run's row**, taken FOR UPDATE first: a duplicate id
 *   waits and finds the first; the shift's end waits or is seen.
 * - **The checkpoint** is read FOR SHARE and its token checked under that
 *   lock: a reissue (FOR UPDATE) committed first and the old printout is
 *   refused, or waits for the scan.
 * - **An ordered route** takes its checkpoints in order, by device time.
 *   The last checkpoint of a run under way completes it.
 * - **The position** is believed or flagged: farther than the checkpoint's
 *   radius is kept, `positionSuspect`.
 */
@Injectable()
export class PatrolScansService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly files: FilesService,
    private readonly core: PatrolCore,
    private readonly runs: RunsCore,
    private readonly media: GateMedia,
  ) {}

  scan(runId: string, input: ScanInput): Promise<ScanView> {
    const reason = this.checkScan(input);
    return this.tenantTx.withTenantTx((tx) =>
      this.scanIn(tx, runId, input, this.ctx.accountId, reason),
    );
  }

  /** A scan's shape, and its manual reason (a code), before any read. */
  checkScan(input: ScanInput): string | null {
    const manual = input.method === 'manual';
    const reason = manual
      ? requireReasonCodeOnly(input.reasonCode, REASON_CODES.patrolManualScan)
      : null;
    this.checkShape(input, manual);
    return reason;
  }

  /**
   * A scan of `guardId`'s run, in the caller's transaction: the online
   * scan's, and an offline one synced later by any guard (ADR 0057), which
   * is the run's guard's still. Its refusals are thrown before any write.
   */
  async scanIn(
    tx: TenantTxClient,
    runId: string,
    input: ScanInput,
    guardId: string,
    reason: string | null,
  ): Promise<ScanView> {
    const manual = input.method === 'manual';
    const run = await this.lockOf(tx, runId, guardId);
    const known = await tx.patrolScan.findUnique({ where: { id: input.id } });
    if (known) return this.replay(known, run, input);
    const checkpointId = manual
      ? input.checkpointId!
      : (parseCheckpointPayload(input.payload!)?.checkpointId ?? null);
    if (!checkpointId) throw invalidCheckpoint();
    const [checkpoint] = await tx.$queryRaw<
      {
        id: string;
        token_hash: string;
        retired: boolean;
        lat: number | null;
        lng: number | null;
        radius_m: number | null;
      }[]
    >`
      SELECT id, token_hash, retired_at IS NOT NULL AS retired,
             lat, lng, radius_m
        FROM patrol_checkpoints WHERE id = ${checkpointId}::uuid FOR SHARE`;
    if (!manual) {
      const token = parseCheckpointPayload(input.payload!)!.token;
      if (
        !checkpoint ||
        checkpoint.retired ||
        !checkpointTokenMatches(
          checkpoint.token_hash,
          this.ctx.txTenantId,
          checkpointId,
          token,
        )
      )
        throw invalidCheckpoint();
    }
    const stops = (await this.core.stops(tx, [run.versionId])).get(
      run.versionId,
    )!;
    const position = stops.findIndex((c) => c.id === checkpointId) + 1;
    if (!checkpoint || position === 0)
      throw appError.unprocessable(
        ErrorCode.PATROL_CHECKPOINT_NOT_ON_ROUTE,
        'The checkpoint is not on this route',
      );
    const now = await dbNow(tx);
    if (
      !inRunLifetime(
        { startedAt: run.startedAt!, endedAt: run.endedAt },
        input.scannedAt,
        now,
      )
    )
      throw outOfWindow('scannedAt');
    if (await tx.patrolScan.count({ where: { runId, checkpointId } }))
      throw appError.conflict(
        ErrorCode.PATROL_CHECKPOINT_ALREADY_SCANNED,
        'This run scanned that checkpoint already',
      );
    const version = await tx.patrolRouteVersion.findUniqueOrThrow({
      where: { id: run.versionId },
    });
    if (version.ordered) {
      const last = await tx.patrolScan.findFirst({
        where: { runId },
        orderBy: [{ position: 'desc' }],
        select: { position: true, scannedAt: true },
      });
      const problem = orderProblem(last, position, input.scannedAt);
      if (problem)
        throw appError.unprocessable(
          ErrorCode.PATROL_OUT_OF_ORDER,
          'Another checkpoint comes first',
          { params: problem },
        );
    }
    const hasPosition = input.lat !== undefined && input.lng !== undefined;
    const distance =
      hasPosition && checkpoint.lat !== null && checkpoint.lng !== null
        ? distanceMetres(
            { lat: input.lat!, lng: input.lng! },
            { lat: checkpoint.lat, lng: checkpoint.lng },
          )
        : null;
    let scan: PatrolScan;
    try {
      scan = await tx.patrolScan.create({
        data: {
          id: input.id,
          tenantId: this.ctx.txTenantId,
          runId,
          checkpointId,
          position,
          method: input.method,
          manualReason: reason,
          scannedAt: input.scannedAt,
          receivedAt: now,
          lat: hasPosition ? input.lat! : null,
          lng: hasPosition ? input.lng! : null,
          accuracyM: hasPosition ? (input.accuracyM ?? null) : null,
          distanceM: distance,
          positionSuspect:
            distance === null ? null : distance > checkpoint.radius_m!,
          guardAccountId: guardId,
        },
      });
    } catch (error) {
      // The id is another run's, recorded meanwhile.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw idUsed();
      throw error;
    }
    let after = await tx.patrolRun.update({
      where: { id: runId },
      data: { scannedCount: { increment: 1 } },
    });
    if (
      after.status === 'in_progress' &&
      after.scannedCount === after.checkpointsTotal
    )
      after = await this.runs.end(tx, after, 'completed', now);
    return ScanView.of(scan, after);
  }

  /**
   * A note at a scan of my run: while it is under way, or 30 minutes after
   * it ended. One per scan; up to three photos and two recordings (ADR
   * 0056), claimed and attached.
   */
  note(runId: string, input: NoteInput): Promise<NoteView> {
    const text = input.text?.trim() || null;
    const photoIds = [...new Set(input.photoFileIds ?? [])];
    const fields: Parameters<typeof invalid>[0] = [];
    if (text && text.length > NOTE_TEXT.max)
      fields.push({
        field: 'text',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...NOTE_TEXT },
      });
    if (photoIds.length > MAX_NOTE_PHOTOS)
      fields.push({
        field: 'photoFileIds',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 0, max: MAX_NOTE_PHOTOS },
      });
    const mediaIds = [...new Set(input.mediaFileIds ?? [])];
    if (mediaIds.length > MAX_NOTE_MEDIA)
      fields.push({
        field: 'mediaFileIds',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 0, max: MAX_NOTE_MEDIA },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await this.lockMine(tx, runId);
      const known = await tx.patrolNote.findUnique({ where: { id: input.id } });
      if (known) {
        if (
          known.runId !== runId ||
          known.scanId !== input.scanId ||
          known.outcome !== input.outcome
        )
          throw idUsed();
        return this.noteView(tx, known);
      }
      const scan = await tx.patrolScan.findFirst({
        where: { id: input.scanId, runId },
      });
      if (!scan)
        throw invalid([
          { field: 'scanId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      if (await tx.patrolNote.count({ where: { scanId: scan.id } }))
        throw appError.conflict(
          ErrorCode.PATROL_NOTE_EXISTS,
          'That scan has its note already',
        );
      const now = await dbNow(tx);
      if (
        run.endedAt &&
        now.getTime() > run.endedAt.getTime() + NOTE_AFTER_END_MINUTES * MINUTE
      )
        throw appError.conflict(
          ErrorCode.PATROL_RUN_NOT_LIVE,
          'The run ended too long ago',
          { params: { status: run.status } },
        );
      if (
        !inRunLifetime(
          { startedAt: run.startedAt!, endedAt: null },
          input.notedAt,
          now,
        )
      )
        throw outOfWindow('notedAt');
      let note: PatrolNote;
      try {
        note = await tx.patrolNote.create({
          data: {
            id: input.id,
            tenantId: this.ctx.txTenantId,
            runId,
            scanId: scan.id,
            outcome: input.outcome,
            text,
            notedAt: input.notedAt,
            receivedAt: now,
            guardAccountId: this.ctx.accountId,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw idUsed();
        throw error;
      }
      for (const fileId of photoIds) {
        const file = await this.files.claim(tx, fileId, 'patrol_photo');
        if (!file)
          throw invalid([
            { field: 'photoFileIds', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        await tx.patrolNotePhoto.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            noteId: note.id,
            fileId,
            uploadedById: this.ctx.accountId,
          },
        });
      }
      for (const m of await this.media.claim(
        tx,
        mediaIds,
        PATROL_NOTE_MEDIA,
        'mediaFileIds',
      ))
        await tx.patrolNoteMedia.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            noteId: note.id,
            fileId: m.fileId,
            kind: m.kind,
            durationMs: m.durationMs,
            uploadedById: this.ctx.accountId,
          },
        });
      return this.noteView(tx, note);
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Before any lock: what each method needs, a position whole. */
  private checkShape(input: ScanInput, manual: boolean): void {
    const fields: Parameters<typeof invalid>[0] = [];
    if (manual) {
      if (!input.checkpointId)
        fields.push({
          field: 'checkpointId',
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      if (input.payload !== undefined)
        fields.push({
          field: 'payload',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    } else {
      if (!input.payload)
        fields.push({ field: 'payload', code: FieldErrorCode.FIELD_REQUIRED });
      if (input.checkpointId !== undefined)
        fields.push({
          field: 'checkpointId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (input.reasonCode !== undefined)
        fields.push({
          field: 'reasonCode',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    }
    if ((input.lat === undefined) !== (input.lng === undefined))
      fields.push({
        field: input.lat === undefined ? 'lat' : 'lng',
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    if (input.accuracyM !== undefined && input.lat === undefined)
      fields.push({
        field: 'accuracyM',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (fields.length) throw invalid(fields);
  }

  /** My run FOR UPDATE, started; anyone else's is not found. */
  private lockMine(tx: TenantTxClient, runId: string): Promise<PatrolRun> {
    return this.lockOf(tx, runId, this.ctx.accountId);
  }

  /** The run under its lock, when it is `guardId`'s; else not found. */
  private async lockOf(
    tx: TenantTxClient,
    runId: string,
    guardId: string,
  ): Promise<PatrolRun> {
    const run = await this.runs.lockRun(tx, runId);
    if (!run || run.guardAccountId !== guardId) throw runNotFound();
    return run;
  }

  /** The same id again: the same answer, or 409 for other content. */
  private replay(
    known: PatrolScan,
    run: PatrolRun,
    input: ScanInput,
  ): ScanView {
    const same =
      known.runId === run.id &&
      known.method === input.method &&
      known.scannedAt.getTime() === input.scannedAt.getTime() &&
      (input.method !== 'manual' || known.checkpointId === input.checkpointId);
    if (!same) throw idUsed();
    return ScanView.of(known, run);
  }

  private async noteView(
    tx: TenantTxClient,
    note: PatrolNote,
  ): Promise<NoteView> {
    const photos = await tx.patrolNotePhoto.count({
      where: { noteId: note.id },
    });
    const media = await tx.patrolNoteMedia.count({
      where: { noteId: note.id },
    });
    return NoteView.of(note, photos, media);
  }
}

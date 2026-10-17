import { ApiProperty } from '@nestjs/swagger';
import type { PatrolNote, PatrolRun, PatrolScan } from '@prisma/client';
import { PresignedReadView } from '../../../core/files/views/file.views';

const METHOD = { enum: ['qr', 'nfc', 'manual'], enumName: 'PatrolScanMethod' };
const OUTCOME = {
  enum: ['all_clear', 'issue_found'],
  enumName: 'PatrolNoteOutcome',
};

export class ScanRunView {
  @ApiProperty({
    enum: [
      'scheduled',
      'in_progress',
      'completed',
      'incomplete',
      'timed_out',
      'missed',
      'cancelled',
    ],
    enumName: 'PatrolRunStatus',
    description: 'The last checkpoint of a run under way completes it.',
  })
  status: string;
  @ApiProperty({ type: Number })
  scannedCount: number;
  @ApiProperty({ type: Number })
  checkpointsTotal: number;
}

/** A scan as its guard is answered (ADR 0052). */
export class ScanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  checkpointId: string;
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty(METHOD)
  method: string;
  @ApiProperty({ type: String, format: 'date-time' })
  scannedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Farther from the checkpoint than its radius: kept, and flagged. Null without a position on either side.',
  })
  positionSuspect: boolean | null;
  @ApiProperty({ type: ScanRunView })
  run: ScanRunView;

  static of(s: PatrolScan, run: PatrolRun): ScanView {
    return {
      id: s.id,
      checkpointId: s.checkpointId,
      position: s.position,
      method: s.method,
      scannedAt: s.scannedAt,
      receivedAt: s.receivedAt,
      positionSuspect: s.positionSuspect,
      run: {
        status: run.status,
        scannedCount: run.scannedCount,
        checkpointsTotal: run.checkpointsTotal,
      },
    };
  }
}

/** A note as its guard is answered. */
export class NoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  scanId: string;
  @ApiProperty(OUTCOME)
  outcome: string;
  @ApiProperty({ type: String, nullable: true })
  text: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  notedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({ type: Number, description: 'How many photos.' })
  photos: number;

  static of(n: PatrolNote, photos: number): NoteView {
    return {
      id: n.id,
      scanId: n.scanId,
      outcome: n.outcome,
      text: n.text,
      notedAt: n.notedAt,
      receivedAt: n.receivedAt,
      photos,
    };
  }
}

/** A scan in a run's detail, for the guards: never a position. */
export class GuardStopScanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty(METHOD)
  method: string;
  @ApiProperty({ type: String, format: 'date-time' })
  scannedAt: Date;
  @ApiProperty({ type: Boolean, nullable: true })
  positionSuspect: boolean | null;

  static of(s: PatrolScan): GuardStopScanView {
    return {
      id: s.id,
      method: s.method,
      scannedAt: s.scannedAt,
      positionSuspect: s.positionSuspect,
    };
  }
}

/** A scan in a run's detail, for the management: where, how, when it came. */
export class StaffStopScanView extends GuardStopScanView {
  @ApiProperty({
    enum: ['qr_damaged', 'qr_missing', 'nfc_unreadable', 'other'],
    enumName: 'PatrolManualScanReason',
    nullable: true,
  })
  manualReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'It reached the server after the run ended (offline).',
  })
  late: boolean;
  @ApiProperty({ type: Number, nullable: true })
  lat: number | null;
  @ApiProperty({ type: Number, nullable: true })
  lng: number | null;
  @ApiProperty({ type: Number, nullable: true })
  accuracyM: number | null;
  @ApiProperty({ type: Number, nullable: true })
  distanceM: number | null;

  static from(s: PatrolScan, run: PatrolRun): StaffStopScanView {
    return {
      ...GuardStopScanView.of(s),
      manualReason: s.manualReason,
      receivedAt: s.receivedAt,
      late: run.endedAt !== null && s.receivedAt > run.endedAt,
      lat: s.lat,
      lng: s.lng,
      accuracyM: s.accuracyM,
      distanceM: s.distanceM,
    };
  }
}

/**
 * A note in a run's detail, for the guards: its outcome; its words and
 * photos only to its author.
 */
export class GuardStopNoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty(OUTCOME)
  outcome: string;
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    description: 'Its author only.',
  })
  text?: string | null;
  @ApiProperty({
    type: [PresignedReadView],
    required: false,
    description: 'Its author only.',
  })
  photos?: PresignedReadView[];

  static of(
    n: PatrolNote,
    own: boolean,
    photos: PresignedReadView[],
  ): GuardStopNoteView {
    return own
      ? { id: n.id, outcome: n.outcome, text: n.text, photos }
      : { id: n.id, outcome: n.outcome };
  }
}

/** A note in a run's detail, for the management. */
export class StaffStopNoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty(OUTCOME)
  outcome: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when none was written, or after its guard’s erasure.',
  })
  text: string | null;
  @ApiProperty({ type: Boolean })
  textCleared: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  notedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({ type: [PresignedReadView] })
  photos: PresignedReadView[];

  static of(n: PatrolNote, photos: PresignedReadView[]): StaffStopNoteView {
    return {
      id: n.id,
      outcome: n.outcome,
      text: n.text,
      textCleared: n.textClearedAt !== null,
      notedAt: n.notedAt,
      receivedAt: n.receivedAt,
      photos,
    };
  }
}

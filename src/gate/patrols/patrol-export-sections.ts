import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';

/**
 * The patrols section of a personal-data export (ADR 0052), `patrols/`,
 * for a guard: the runs they started (route and post by name, times,
 * statuses), their scans (where they were, as their device said), their
 * notes (outcome, words, how many photos) and where they walked, while it
 * is kept. Never another guard's name or words.
 */
@Injectable()
export class PatrolExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('patrols', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const d = await this.tenantTx.withTenantTx(async (tx) => {
      const runs = await tx.patrolRun.findMany({
        where: { guardAccountId: me },
        orderBy: [{ plannedAt: 'asc' }, { id: 'asc' }],
      });
      const scans = await tx.patrolScan.findMany({
        where: { guardAccountId: me },
        orderBy: [{ scannedAt: 'asc' }, { id: 'asc' }],
      });
      const notes = await tx.patrolNote.findMany({
        where: { guardAccountId: me },
        orderBy: [{ notedAt: 'asc' }, { id: 'asc' }],
      });
      const photos = new Map<string, number>();
      for (const p of notes.length
        ? await tx.patrolNotePhoto.findMany({
            where: { noteId: { in: notes.map((n) => n.id) } },
            select: { noteId: true },
          })
        : [])
        photos.set(p.noteId, (photos.get(p.noteId) ?? 0) + 1);
      const track = await tx.patrolTrackPoint.findMany({
        where: { guardAccountId: me },
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      });
      const routes = new Map(
        (
          await tx.patrolRoute.findMany({
            where: { id: { in: [...new Set(runs.map((r) => r.routeId))] } },
            select: { id: true, nameEn: true },
          })
        ).map((r) => [r.id, r.nameEn]),
      );
      const checkpoints = new Map(
        (
          await tx.patrolCheckpoint.findMany({
            where: {
              id: { in: [...new Set(scans.map((x) => x.checkpointId))] },
            },
            select: { id: true, nameEn: true },
          })
        ).map((c) => [c.id, c.nameEn]),
      );
      const gates = new Map(
        (
          await tx.gate.findMany({
            where: {
              id: { in: runs.flatMap((r) => (r.gateId ? [r.gateId] : [])) },
            },
            select: { id: true, name: true },
          })
        ).map((g) => [g.id, g.name]),
      );
      const zones = new Map(
        (
          await tx.place.findMany({
            where: {
              id: { in: runs.flatMap((r) => (r.placeId ? [r.placeId] : [])) },
            },
            select: { id: true, nameEn: true },
          })
        ).map((z) => [z.id, z.nameEn]),
      );
      return {
        runs,
        scans,
        notes,
        photos,
        track,
        routes,
        checkpoints,
        gates,
        zones,
      };
    });
    yield {
      path: 'patrols/runs.json',
      json: d.runs.map((r) => ({
        route: d.routes.get(r.routeId) ?? null,
        ...(r.gateId
          ? { gate: d.gates.get(r.gateId) ?? null }
          : { zone: d.zones.get(r.placeId!) ?? null }),
        kind: r.kind,
        status: r.status,
        scheduledStart: r.scheduledStart,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        endReason: r.endReason,
        late: r.lateAt !== null,
        checkpoints: r.checkpointsTotal,
        scanned: r.scannedCount,
      })),
    };
    yield {
      path: 'patrols/scans.json',
      json: d.scans.map((x) => ({
        checkpoint: d.checkpoints.get(x.checkpointId) ?? null,
        method: x.method,
        manualReason: x.manualReason,
        scannedAt: x.scannedAt,
        receivedAt: x.receivedAt,
        lat: x.lat,
        lng: x.lng,
        accuracyM: x.accuracyM,
        positionSuspect: x.positionSuspect,
      })),
    };
    yield {
      path: 'patrols/notes.json',
      json: d.notes.map((n) => ({
        outcome: n.outcome,
        text: n.text,
        notedAt: n.notedAt,
        photos: d.photos.get(n.id) ?? 0,
      })),
    };
    yield {
      path: 'patrols/track.json',
      json: d.track.map((p) => ({
        recordedAt: p.recordedAt,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM,
      })),
    };
  }
}

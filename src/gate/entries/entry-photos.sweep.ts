import { Injectable, type OnModuleInit } from '@nestjs/common';
import { FilesService } from '../../core/files/files.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';

export const VISITOR_PHOTOS_SWEEP = 'gate.visitor_photos';

/**
 * A visitor's photo at entry is deleted 30 days after the entry (ADR 0056):
 * the row, then the file (the files sweep removes the object). Not while
 * an incident's evidence names it: kept for as long as the incident is.
 *
 * The row is taken FOR UPDATE SKIP LOCKED: an evidence link in flight holds
 * it FOR SHARE, so the purge skips it this time, and finds it linked the
 * next; a purge that took it first wins, and the link finds no photo.
 */
@Injectable()
export class EntryPhotosSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(VISITOR_PHOTOS_SWEEP, (now) =>
      this.sweep.forEachTenant(async (tx, tenantId) => {
        const due = await tx.gateEntryPhoto.findMany({
          where: { purgeAfter: { lte: now } },
          select: { entryId: true, fileId: true },
        });
        let purged = 0;
        for (const p of due) {
          const held = await tx.$queryRaw<{ entry_id: string }[]>`
            SELECT entry_id FROM gate_entry_photos
             WHERE tenant_id = ${tenantId}::uuid AND entry_id = ${p.entryId}::uuid
               FOR UPDATE SKIP LOCKED`;
          if (!held.length) continue;
          if (
            await tx.incidentEvidence.count({ where: { entryId: p.entryId } })
          )
            continue;
          await tx.gateEntryPhoto.delete({
            where: { tenantId_entryId: { tenantId, entryId: p.entryId } },
          });
          await this.files.markDeleted(
            tx,
            { id: p.fileId, purpose: 'visitor_photo' },
            'retention',
          );
          purged++;
        }
        return purged;
      }),
    );
  }
}

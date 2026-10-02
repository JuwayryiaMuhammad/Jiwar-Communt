import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { WorkersService } from './workers.service';

export const WORKER_PHOTO_RETENTION_SWEEP = 'workers.photo_retention';

/** Workers taken per compound and run. */
const BATCH = 500;

/**
 * A worker's photo is kept while the compound may still see them at the
 * gate (ADR 0029): it is deleted once none of their engagements is pending,
 * active or suspended, and none has changed for WORKER_PHOTO_RETENTION_DAYS
 * (an engagement's last change is its end). The pointer is cleared and the
 * file marked deleted here; the files sweep deletes the object, then the row.
 */
@Injectable()
export class WorkerPhotoRetention implements OnModuleInit {
  private readonly retentionMs: number;

  constructor(
    private readonly sweep: SweepRunner,
    private readonly workers: WorkersService,
    config: ConfigService<Env, true>,
  ) {
    this.retentionMs =
      config.get('WORKER_PHOTO_RETENTION_DAYS', { infer: true }) * 86_400_000;
  }

  onModuleInit(): void {
    this.sweep.register(WORKER_PHOTO_RETENTION_SWEEP, (now) => this.run(now));
  }

  run(now: Date): Promise<number> {
    const before = new Date(now.getTime() - this.retentionMs);
    return this.sweep.forEachTenant(async (tx) => {
      // SKIP LOCKED: a worker a registration or a manager holds is left for
      // the next run, which sees what they did.
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT w.id FROM domestic_workers w
         WHERE w.photo_file_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM worker_engagements e
              WHERE e.worker_id = w.id
                AND (e.status IN ('pending_review', 'active', 'suspended')
                     OR e.updated_at >= ${before}))
         ORDER BY w.id LIMIT ${BATCH}
         FOR UPDATE OF w SKIP LOCKED`;
      let dropped = 0;
      for (const { id } of due) {
        if (await this.workers.dropPhoto(tx, id, 'retention')) dropped += 1;
      }
      return dropped;
    });
  }
}

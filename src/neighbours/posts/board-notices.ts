import { Injectable } from '@nestjs/common';
import type { NeighbourPost } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';

type Subject = Pick<NeighbourPost, 'id' | 'kind'>;

/**
 * The boards' notifications (ADR 0027, 0042), in the action's transaction.
 * The category is `neighbours`; no kind is critical. The only param is the
 * post's kind: never its words, its place, or anyone's name or building.
 */
@Injectable()
export class BoardNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
  ) {}

  /** Tells every account holding `neighbours.handle` now, but the one who acted. */
  async toHandlers(
    tx: TenantTxClient,
    post: Subject,
    kind: NotificationKind,
    except: string | null = null,
  ): Promise<void> {
    await this.to(
      tx,
      (await this.staff.holding(tx, 'neighbours.handle')).map((r) => r.id),
      post,
      kind,
      except,
    );
  }

  /** The active accounts among `to`, never `except` (the one who acted). */
  async to(
    tx: TenantTxClient,
    to: readonly string[],
    post: Subject,
    kind: NotificationKind,
    except: string | null = null,
  ): Promise<void> {
    const ids = [...new Set(to)].filter((id) => id !== except);
    if (!ids.length) return;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return;
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params: { postKind: post.kind }, targetId: post.id },
    );
  }
}

import { Injectable } from '@nestjs/common';
import type { NeighbourComplaint } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { complaintNumber } from './complaint-rules';

type Subject = Pick<
  NeighbourComplaint,
  'id' | 'number' | 'categoryId' | 'authorId'
>;

/**
 * A complaint's notifications (ADR 0027, 0042), in the action's
 * transaction: inbox rows for its author and for the staff. The category
 * is `neighbours`; no kind is critical.
 *
 * Params are the complaint's number and its category's key, and nothing
 * else: never a message, a note, a notice's text, a unit or anyone's name.
 * What happened is the kind; the rest is read on the complaint. The unit
 * complained about is told by NoticesService, about its notice and never
 * with the complaint's number.
 */
@Injectable()
export class ComplaintNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
  ) {}

  /** Tells the complaint's author (unless they are the one who acted). */
  toAuthor(
    tx: TenantTxClient,
    complaint: Subject,
    kind: NotificationKind,
  ): Promise<void> {
    return this.send(tx, [complaint.authorId], kind, complaint);
  }

  /** Tells every account holding `neighbours.handle` now, but the one who acted. */
  async toHandlers(
    tx: TenantTxClient,
    complaint: Subject,
    kind: NotificationKind,
    except: string | null = null,
  ): Promise<void> {
    await this.send(
      tx,
      (await this.staff.holding(tx, 'neighbours.handle')).map((r) => r.id),
      kind,
      complaint,
      except,
    );
  }

  /** The active accounts among `to`, never `except` (the one who acted). */
  private async send(
    tx: TenantTxClient,
    to: readonly string[],
    kind: NotificationKind,
    complaint: Subject,
    except: string | null = null,
  ): Promise<void> {
    const ids = [...new Set(to)].filter((id) => id !== except);
    if (!ids.length) return;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return;
    const category = await tx.neighbourComplaintCategory.findUniqueOrThrow({
      where: { id: complaint.categoryId },
      select: { key: true },
    });
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      {
        kind,
        params: {
          complaintNumber: complaintNumber(complaint.number),
          categoryKey: category.key,
        },
        targetId: complaint.id,
      },
    );
  }
}

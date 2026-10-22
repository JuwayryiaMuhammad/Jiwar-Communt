import { Injectable } from '@nestjs/common';
import type { ManagementRequest } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { requestNumber } from './request-rules';

type Subject = Pick<
  ManagementRequest,
  'id' | 'number' | 'topicId' | 'authorId' | 'assigneeId'
>;

/**
 * A management request's notifications (ADR 0027, 0039), in the action's
 * transaction: inbox rows, for the author and for the staff alike. The
 * category is `management`; no kind is critical.
 *
 * Params are the request number and the topic's key, and nothing else:
 * never a message, a note, a rating, a reason somebody typed, or anyone's
 * name. What happened is the kind; the rest is read on the request.
 */
@Injectable()
export class RequestNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
  ) {}

  /** Tells the request's author (unless they are the one who acted). */
  toAuthor(
    tx: TenantTxClient,
    request: Subject,
    kind: NotificationKind,
    except: string | null = null,
  ): Promise<void> {
    return this.send(tx, [request.authorId], kind, request, except);
  }

  /**
   * Tells whoever handles the request: its assignee, or, while it is in
   * the queue, every account holding `requests.handle` now.
   */
  async toHandlers(
    tx: TenantTxClient,
    request: Subject,
    kind: NotificationKind,
    except: string | null = null,
  ): Promise<void> {
    const to = request.assigneeId
      ? [request.assigneeId]
      : await this.queueHandlers(tx, request.topicId);
    await this.send(tx, to, kind, request, except);
  }

  /**
   * Who handles the unassigned queue of a topic (ADR 0058): the handlers of
   * the role that owns it, or every handler when it has no owner or the
   * owner has none.
   */
  private async queueHandlers(
    tx: TenantTxClient,
    topicId: string,
  ): Promise<string[]> {
    const all = (await this.staff.holding(tx, 'requests.handle')).map(
      (r) => r.id,
    );
    const topic = await tx.managementRequestTopic.findUnique({
      where: { id: topicId },
      select: { ownerRoleId: true },
    });
    if (!topic?.ownerRoleId || !all.length) return all;
    const owners = await tx.account.findMany({
      where: { id: { in: all }, roleId: topic.ownerRoleId },
      select: { id: true },
    });
    return owners.length ? owners.map((a) => a.id) : all;
  }

  /** Tells the assignee alone; nobody when the request is in the queue. */
  toAssignee(
    tx: TenantTxClient,
    request: Subject,
    kind: NotificationKind,
    except: string | null = null,
  ): Promise<void> {
    return this.send(tx, [request.assigneeId], kind, request, except);
  }

  /** Tells every account holding `requests.manage` now. */
  async toManagers(
    tx: TenantTxClient,
    request: Subject,
    kind: NotificationKind,
  ): Promise<void> {
    await this.send(
      tx,
      (await this.staff.holding(tx, 'requests.manage')).map((r) => r.id),
      kind,
      request,
    );
  }

  /** The active accounts among `to`, never `except` (the one who acted). */
  private async send(
    tx: TenantTxClient,
    to: readonly (string | null)[],
    kind: NotificationKind,
    request: Subject,
    except: string | null = null,
  ): Promise<void> {
    const ids = [...new Set(to)].filter(
      (id): id is string => id !== null && id !== except,
    );
    if (!ids.length) return;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return;
    const topic = await tx.managementRequestTopic.findUniqueOrThrow({
      where: { id: request.topicId },
      select: { key: true },
    });
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      {
        kind,
        params: {
          requestNumber: requestNumber(request.number),
          topicKey: topic.key,
        },
        targetId: request.id,
      },
    );
  }
}

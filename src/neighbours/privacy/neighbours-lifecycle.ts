import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NeighbourPost } from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import {
  AccountLifecycle,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import { PostsService } from '../posts/posts.service';

/**
 * What the neighbours domain does when an account is erased or leaves the
 * compound (ADR 0023, 0042), in the transaction that causes it.
 *
 * Erasure, exactly as management requests do it (ADR 0039): the person's
 * words go and the rows stay, pointing at the tombstone. The erasure holds
 * the account's row exclusively and every write here takes it shared
 * first, so nothing of theirs lands after.
 * - the bodies of the messages they sent, on complaints and in masked
 *   conversations (the one UPDATE those tables' triggers let through);
 * - the words and the place of the posts they wrote as a resident, which
 *   close, and those posts' photos: the files and their photo rows;
 * - the notes they gave the staff on a claim or a report; their pending
 *   claims are taken back;
 * - their conversations close, and their blocks, either way, are deleted.
 * What the staff wrote stays: a notice, a staff reply, a post made as the
 * management. So do a complaint's evidence files, which belong to the
 * complaint, and every status, handover and decision.
 *
 * Leaving: someone with no place left in the compound is no longer a
 * neighbour. Their posts leave the boards and their conversations close.
 * Their complaints stay with the staff.
 */
@Injectable()
export class NeighboursLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityNeighboursPort,
    private readonly posts: PostsService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing((tx, account) => this.erase(tx, account.id));
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      if ((await this.community.places(tx, account.id)).length) return;
      const now = await dbNow(tx);
      await this.endPosts(tx, account.id, 'author_left', now);
      await this.endConversations(tx, account.id, 'participant_left', now);
    });
  }

  private async erase(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<AfterCommit[]> {
    const now = await dbNow(tx);
    await this.endPosts(tx, accountId, 'author_erased', now);
    await this.endConversations(tx, accountId, 'participant_erased', now);
    await tx.$executeRaw`
      UPDATE neighbour_complaint_messages
         SET body = NULL, erased_at = ${now}
       WHERE sender_account_id = ${accountId}::uuid AND body IS NOT NULL`;
    await tx.$executeRaw`
      UPDATE neighbour_conversation_messages
         SET body = NULL, erased_at = ${now}
       WHERE sender_account_id = ${accountId}::uuid AND body IS NOT NULL`;
    await tx.$executeRaw`
      UPDATE neighbour_posts
         SET body = NULL, place = NULL, erased_at = ${now}, updated_at = ${now}
       WHERE author_account_id = ${accountId}::uuid
         AND author_side = 'resident' AND body IS NOT NULL`;
    await tx.$executeRaw`
      UPDATE neighbour_item_claims
         SET status = 'withdrawn', decided_at = ${now}, updated_at = ${now}
       WHERE claimant_account_id = ${accountId}::uuid AND status = 'pending'`;
    await tx.$executeRaw`
      UPDATE neighbour_item_claims SET note = NULL, updated_at = ${now}
       WHERE claimant_account_id = ${accountId}::uuid AND note IS NOT NULL`;
    await tx.$executeRaw`
      UPDATE neighbour_conversation_reports SET note = NULL, updated_at = ${now}
       WHERE reporter_account_id = ${accountId}::uuid AND note IS NOT NULL`;
    await tx.neighbourBlock.deleteMany({
      where: { OR: [{ blockerId: accountId }, { blockedId: accountId }] },
    });
    // The photos of their posts: each file marked deleted and its photo row
    // gone with it, now; the objects and the file rows after the commit. A
    // photo row left behind would keep its file's row from ever being
    // deleted (the files sweep would try again on every run).
    const photos = await tx.neighbourPostPhoto.findMany({
      where: { post: { authorId: accountId, authorSide: 'resident' } },
      select: { id: true, fileId: true },
      orderBy: { fileId: 'asc' },
    });
    for (const p of photos)
      await this.files.markDeleted(
        tx,
        { id: p.fileId, purpose: 'neighbour_post_photo' },
        'erasure',
      );
    if (photos.length)
      await tx.neighbourPostPhoto.deleteMany({
        where: { id: { in: photos.map((p) => p.id) } },
      });
    return photos.map((p) => async () => {
      await this.files.purge(p.fileId);
    });
  }

  /** Closes the resident's posts still open, locked in id order. */
  private async endPosts(
    tx: TenantTxClient,
    accountId: string,
    reason: 'author_left' | 'author_erased',
    now: Date,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM neighbour_posts
       WHERE author_account_id = ${accountId}::uuid
         AND author_side = 'resident' AND status = 'open'
       ORDER BY id FOR UPDATE`;
    for (const { id } of rows) {
      const post: NeighbourPost = await tx.neighbourPost.findUniqueOrThrow({
        where: { id },
      });
      await this.posts.end(tx, post, reason, now, 'neighbour_post.closed');
    }
  }

  /** Closes the conversations the account is a side of, locked in id order. */
  private async endConversations(
    tx: TenantTxClient,
    accountId: string,
    reason: 'participant_left' | 'participant_erased',
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE neighbour_conversations
         SET closed_at = ${now}, close_reason = ${reason}, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM neighbour_conversations
          WHERE closed_at IS NULL
            AND (author_account_id = ${accountId}::uuid
              OR responder_account_id = ${accountId}::uuid)
          ORDER BY id FOR UPDATE)`;
  }
}

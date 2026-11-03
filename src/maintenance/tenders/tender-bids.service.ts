import { Injectable } from '@nestjs/common';
import type { Tender, TenderBid, TenderInvitation } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { ContractorAccess } from '../contractors/contractor-access';
import { dbNow } from '../db-clock';
import { VendorsService } from '../vendors/vendors.service';
import { tenderNotFound, tenderState } from './tenders.service';

export interface BidInput {
  /** Two places, more than zero. */
  amount: string;
  durationDays?: number;
  note?: string;
  /** A `tender_bid` file the caller uploaded (a contractor only). */
  fileId?: string;
}

/**
 * A tender as one invitee sees it (ADR 0088): its terms, deadline and
 * documents, its own bid and how the tender ended for it. Never another
 * invitee, another bid, or any amount before the opening — its own
 * included: the database keeps the seal.
 */
export interface InviteeTender {
  tender: Tender;
  invitation: TenderInvitation;
  documents: { id: string; title: string; read: PresignedRead | null }[];
  bid: TenderBid | null;
  outcome: 'awarded' | 'not_awarded' | 'cancelled' | null;
}

const bidExists = (bidId: string) =>
  appError.conflict(
    ErrorCode.TENDER_BID_EXISTS,
    'A bid is in already: withdraw it first',
    { params: { bidId } },
  );
export const bidNotFound = () =>
  appError.notFound(ErrorCode.TENDER_BID_NOT_FOUND, 'Bid not found');

/**
 * Bids (ADR 0088), by a registered vendor's contractors (`tenders.bid`) and
 * through a bid link (BidLinkService); one live bid an invitation, sealed
 * when it comes in.
 *
 * A bid is taken while its tender is open and its deadline has not passed
 * **by the database's clock, read after the tender's row is shared-locked**:
 * the opening takes that row for update, so a bid that came in before the
 * deadline is either committed before the opening reads the bids, or waits
 * for it and is then refused (`TENDER_CLOSED`). A bid at the deadline is
 * late. Withdrawn while the tender takes bids, never edited; another may
 * then be sent. Revoked invitations take none.
 *
 * Locks: the caller → the tender (shared) → the invitation (shared) → the
 * vendor (shared: not suspended meanwhile) → the file.
 */
@Injectable()
export class TenderBidsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly contractor: ContractorAccess,
    private readonly vendors: VendorsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  // --------------------------------------------------------------------------
  // A registered vendor's contractors
  // --------------------------------------------------------------------------

  /** The tenders the caller's vendor is invited to, published, newest first. */
  invited(): Promise<InviteeTender[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vendorId = await this.contractor.vendorOf(tx);
      const invitations = await tx.tenderInvitation.findMany({
        where: { vendorId, revokedAt: null },
        orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const out: InviteeTender[] = [];
      for (const i of invitations) {
        const read = await this.inviteeRead(tx, i, false);
        if (read) out.push(read);
      }
      return out;
    });
  }

  /** One of them, with its documents. */
  get(tenderId: string): Promise<InviteeTender> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vendorId = await this.contractor.vendorOf(tx);
      const invitation = await this.invitationOf(tx, tenderId, vendorId);
      const read = invitation
        ? await this.inviteeRead(tx, invitation, true)
        : null;
      if (!read) throw tenderNotFound();
      return read;
    });
  }

  submit(tenderId: string, input: BidInput): Promise<InviteeTender> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { vendorId } = await this.contractor.lockSelf(tx);
      const tender = await this.shareTender(tx, tenderId);
      const invitation = await this.invitationOf(tx, tenderId, vendorId, true);
      if (!invitation || tender.status === 'draft') throw tenderNotFound();
      await this.vendors.lockUsable(tx, vendorId);
      await this.submitIn(tx, tender, invitation, input, {
        by: this.ctx.accountId,
        vendorId,
      });
      return (await this.inviteeRead(tx, invitation, true))!;
    });
  }

  withdraw(tenderId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { vendorId } = await this.contractor.lockSelf(tx);
      const tender = await this.shareTender(tx, tenderId);
      const invitation = await this.invitationOf(tx, tenderId, vendorId, true);
      if (!invitation || tender.status === 'draft') throw tenderNotFound();
      await this.withdrawIn(tx, tender, invitation, 'contractor');
    });
  }

  // --------------------------------------------------------------------------
  // Shared with the bid link
  // --------------------------------------------------------------------------

  /** The tender's row, shared: an opening (update) waits for this bid. */
  async shareTender(tx: TenantTxClient, tenderId: string): Promise<Tender> {
    await tx.$queryRaw`SELECT id FROM tenders WHERE id = ${tenderId}::uuid FOR SHARE`;
    const tender = await tx.tender.findUnique({ where: { id: tenderId } });
    if (!tender) throw tenderNotFound();
    return tender;
  }

  /** Under the tender's shared lock and the invitation's. */
  async submitIn(
    tx: TenantTxClient,
    tender: Tender,
    invitation: TenderInvitation,
    input: BidInput,
    from: { by: string | null; vendorId: string | null },
  ): Promise<string> {
    await takingBids(tx, tender);
    if (!(Number(input.amount) > 0))
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid bid', {
        fields: [
          {
            field: 'amount',
            code: FieldErrorCode.INVALID_VALUE,
            params: { min: '0.01' },
          },
        ],
      });
    const live = await tx.tenderBid.findFirst({
      where: { invitationId: invitation.id, withdrawnAt: null },
      select: { id: true },
    });
    if (live) throw bidExists(live.id);
    let fileId: string | null = null;
    if (input.fileId) {
      const file = await this.files.claim(tx, input.fileId, 'tender_bid');
      if (!file)
        throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid bid', {
          fields: [
            { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ],
        });
      await this.files.attach(tx, file);
      fileId = file.id;
    }
    const id = newId();
    const now = await dbNow(tx);
    // The amount goes into the seal, a column the app's role writes and
    // never reads; `amount` stays NULL until the opening.
    await tx.$executeRaw`
      INSERT INTO tender_bids
        (id, tenant_id, tender_id, invitation_id, submitted_by_account_id,
         submitted_at, sealed_amount, duration_days, note, file_id, vendor_id)
      VALUES (${id}::uuid, ${tender.tenantId}::uuid, ${tender.id}::uuid,
              ${invitation.id}::uuid, ${from.by}::uuid, ${now},
              ${input.amount}::numeric, ${input.durationDays ?? null}::int,
              ${input.note?.trim() || null}, ${fileId}::uuid,
              ${from.vendorId}::uuid)`;
    await this.audit.record(tx, {
      action: 'tender_bid.submitted',
      targetId: id,
      // Never the amount: it is sealed.
      metadata: {
        tenderId: tender.id,
        invitationId: invitation.id,
        via: from.by ? 'contractor' : 'link',
        withDocument: fileId !== null,
      },
    });
    return id;
  }

  async withdrawIn(
    tx: TenantTxClient,
    tender: Tender,
    invitation: TenderInvitation,
    via: 'contractor' | 'link',
  ): Promise<void> {
    await takingBids(tx, tender);
    const live = await tx.tenderBid.findFirst({
      where: { invitationId: invitation.id, withdrawnAt: null },
    });
    if (!live) throw bidNotFound();
    await tx.tenderBid.update({
      where: { id: live.id },
      data: { withdrawnAt: await dbNow(tx) },
    });
    await this.audit.record(tx, {
      action: 'tender_bid.withdrawn',
      targetId: live.id,
      metadata: { tenderId: tender.id, invitationId: invitation.id, via },
    });
  }

  /**
   * What an invitee reads; null for a draft (not yet published) tender.
   * Documents are read on the detail only.
   */
  async inviteeRead(
    tx: TenantTxClient,
    invitation: TenderInvitation,
    withDocuments: boolean,
  ): Promise<InviteeTender | null> {
    const tender = await tx.tender.findUniqueOrThrow({
      where: { id: invitation.tenderId },
    });
    if (tender.status === 'draft') return null;
    const bid =
      (await tx.tenderBid.findFirst({
        where: { invitationId: invitation.id, withdrawnAt: null },
      })) ??
      (await tx.tenderBid.findFirst({
        where: { invitationId: invitation.id },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      }));
    const documents: InviteeTender['documents'] = [];
    if (withDocuments)
      for (const d of await tx.tenderDocument.findMany({
        where: { tenderId: tender.id, removedAt: null },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      }))
        documents.push({
          id: d.id,
          title: d.title,
          read: await this.files.readUrl(tx, d.fileId),
        });
    const outcome =
      tender.status === 'cancelled'
        ? 'cancelled'
        : tender.status === 'awarded'
          ? bid && tender.awardedBidId === bid.id
            ? 'awarded'
            : 'not_awarded'
          : null;
    return { tender, invitation, documents, bid, outcome };
  }

  private async invitationOf(
    tx: TenantTxClient,
    tenderId: string,
    vendorId: string,
    lock = false,
  ): Promise<TenderInvitation | null> {
    const found = await tx.tenderInvitation.findFirst({
      where: { tenderId, vendorId, revokedAt: null },
      select: { id: true },
    });
    if (!found) return null;
    if (lock)
      await tx.$queryRaw`SELECT id FROM tender_invitations WHERE id = ${found.id}::uuid FOR SHARE`;
    // Read again after the lock: a revocation that won is seen.
    const invitation = await tx.tenderInvitation.findUnique({
      where: { id: found.id },
    });
    return invitation && invitation.revokedAt === null ? invitation : null;
  }
}

/** Open, before its deadline by the database's clock (read after the lock). */
async function takingBids(tx: TenantTxClient, tender: Tender): Promise<void> {
  if (tender.status !== 'open') {
    if (['opening', 'opened', 'awarded'].includes(tender.status))
      throw appError.conflict(
        ErrorCode.TENDER_CLOSED,
        'The deadline passed: bids are no longer taken',
        { params: { bidsDueAt: tender.bidsDueAt.toISOString() } },
      );
    throw tenderState(tender.status);
  }
  if (tender.bidsDueAt <= (await dbNow(tx)))
    throw appError.conflict(
      ErrorCode.TENDER_CLOSED,
      'The deadline passed: bids are no longer taken',
      { params: { bidsDueAt: tender.bidsDueAt.toISOString() } },
    );
}

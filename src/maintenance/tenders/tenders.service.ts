import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type Tender,
  type TenderBid,
  type TenderDocument,
  type TenderInvitation,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { contractorsOf } from '../contractors/contractor-access';
import { MaintenanceContractsService } from '../contracts/contracts.service';
import type { ContractKind } from '../contracts/contract-rules';
import { dbNow } from '../db-clock';
import type { LocalDate } from '../schedules/local-dates';
import {
  nextProcurementNumber,
  VendorsService,
} from '../vendors/vendors.service';
import type { VendorCategory } from '../vendors/vendor-rules';
import { bidLink, bidTokenHash, newBidToken } from './bid-link-tokens';
import { TenderView } from './views/tender.views';
import {
  CANCELLABLE,
  TENDER_LIMITS,
  tenderReference,
  type TenderStatus,
} from './tender-rules';

export const TENDER_RESOURCE = 'tender';
/** A bid link lives this long at most; bids stop at the tender's deadline. */
export const TENDER_LINK_DAYS = 90;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface TenderInput {
  title: string;
  scope?: string;
  category: VendorCategory;
  contractKind: ContractKind;
  budgetLineId?: string;
  estimatedValue?: string;
  bidsDueAt: Date;
}

export type TenderPatch = Partial<
  Omit<TenderInput, 'scope' | 'budgetLineId' | 'estimatedValue'>
> & {
  scope?: string | null;
  budgetLineId?: string | null;
  estimatedValue?: string | null;
};

export interface AwardInput {
  bidId: string;
  /** The contract's code, unique in the compound (ADR 0065). */
  code: string;
  startsOn: LocalDate;
  endsOn: LocalDate;
  /** The board's approved major contract, above the manager's limit. */
  approvalRequestId?: string;
}

/** A bid as staff read it: sealed (no amount, no terms) until the opening. */
export interface BidRead {
  bid: TenderBid;
  invitation: TenderInvitation;
  vendorName: string | null;
  fileUrl: PresignedRead | null;
}

export interface TenderRecord {
  tender: Tender;
  documents: { document: TenderDocument; read: PresignedRead | null }[];
  invitations: {
    invitation: TenderInvitation;
    vendorName: string | null;
    linkExpiresAt: Date | null;
  }[];
  bids: BidRead[];
  /** The contract the award signed. */
  contract: { id: string; code: string } | null;
}

/** A link made, shown once. */
export interface IssuedLink {
  invitation: TenderInvitation;
  url: string;
  expiresAt: Date;
}

const PAGE = keysetCursor('createdAt');

export const tenderNotFound = () =>
  appError.notFound(ErrorCode.TENDER_NOT_FOUND, 'Tender not found');
export const tenderState = (status: string) =>
  appError.conflict(
    ErrorCode.TENDER_STATE,
    'The tender is not in a state that allows this',
    { params: { status } },
  );
const invitationNotFound = () =>
  appError.notFound(
    ErrorCode.TENDER_INVITATION_NOT_FOUND,
    'Invitation not found',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid tender', {
    fields,
  });

/**
 * Tenders (ADR 0088), kept with `tenders.manage`; their opening is
 * `tenders.open`'s, two holders each on their own.
 *
 * - A **draft** with its title, scope, trade, the contract its award will
 *   sign, a budget line and an estimate, and its deadline; its documents
 *   (`tender_document` files, 20 live at most) and invitations are added
 *   while it is a draft or takes bids. **Published**, it takes bids until its
 *   deadline (at least an hour ahead, at most a year), which may only move
 *   later before it passes; its terms are then fixed (a trigger).
 * - **Invited**: a vendor of the register, not suspended — its contractors
 *   bid — or a company that is not registered, with a **bid link**: an
 *   unguessable token of this tender alone, shown once, living 90 days at
 *   most, rate-limited, revoked with its invitation or replaced by a new
 *   one; it opens nothing else.
 * - **Sealed**: a bid's amount is the database's to keep until the opening
 *   (`tender_bids.sealed_amount`, unreadable by the app's role). Before it,
 *   staff see who sent a bid and when, nothing of its terms.
 * - **Opened** by two people: after the deadline, a first holder of
 *   `tenders.open` begins the opening; a second, different one confirms it,
 *   and the database unseals every live bid at that moment (a CHECK keeps
 *   the two apart; the permission is never a deputy's). Both are recorded.
 * - **Awarded** to one bid: the compound's contract (ADR 0077) is signed
 *   with its vendor — a link bidder is found in the register by its name or
 *   registered — at the bid's amount, in this transaction; above the
 *   manager's limit it needs the board's approved major contract (ADR 0055,
 *   binding, ADR 0073), and that approval signs this contract and no other
 *   (the claim lock of ADR 0077): no second approval is asked for.
 * - **Called off** with a code, any time before the award.
 *
 * Locks: the caller → the tender (update; shared by a bid) → an invitation
 * (update; shared by a bid) → the bid → the vendor (shared, or the name's
 * lock) → the threshold's row → the approval request → its claim lock →
 * the counters.
 */
@Injectable()
export class TendersService implements OnModuleInit {
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly globalDb: GlobalDbService,
    private readonly files: FilesService,
    private readonly vendors: VendorsService,
    private readonly contracts: MaintenanceContractsService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(TENDER_RESOURCE, async (id) =>
      TenderView.fromRecord(await this.get(id)),
    );
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /** Newest first; `status` narrows it. */
  list(q: {
    status?: TenderStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<Tender>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.tender.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<TenderRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tender = await tx.tender.findUnique({ where: { id } });
      if (!tender) throw tenderNotFound();
      return this.load(tx, tender);
    });
  }

  // --------------------------------------------------------------------------
  // The draft
  // --------------------------------------------------------------------------

  create(input: TenderInput): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: TENDER_RESOURCE, id });
        await this.requireLine(tx, input.budgetLineId ?? null);
        const now = await dbNow(tx);
        requireDeadline(input.bidsDueAt, now, false);
        const number = await nextProcurementNumber(
          tx,
          this.ctx.txTenantId,
          'tender',
        );
        const tender = await tx.tender.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            number,
            title: input.title.trim(),
            scope: input.scope?.trim() || null,
            category: input.category,
            contractKind: input.contractKind,
            budgetLineId: input.budgetLineId ?? null,
            estimatedValue: input.estimatedValue ?? null,
            bidsDueAt: input.bidsDueAt,
            createdById: this.ctx.accountId,
            createdAt: now,
          },
        });
        await this.audit.record(tx, {
          action: 'tender.created',
          targetId: id,
          changes: diffChanges(null, audited(tender), 'tender.created'),
          metadata: { number },
        });
        return id;
      })
      .then((id) => this.get(id));
  }

  /** A draft's terms; a published tender's are fixed. */
  update(id: string, input: TenderPatch): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'draft') throw tenderState(before.status);
        if (input.budgetLineId) await this.requireLine(tx, input.budgetLineId);
        const now = await dbNow(tx);
        if (input.bidsDueAt) requireDeadline(input.bidsDueAt, now, false);
        const tender = await tx.tender.update({
          where: { id },
          data: {
            title: input.title?.trim(),
            scope:
              input.scope === undefined
                ? undefined
                : input.scope?.trim() || null,
            category: input.category,
            contractKind: input.contractKind,
            budgetLineId: input.budgetLineId,
            estimatedValue: input.estimatedValue,
            bidsDueAt: input.bidsDueAt,
          },
        });
        const changes = diffChanges(
          audited(before),
          audited(tender),
          'tender.updated',
        );
        if (Object.keys(changes).length)
          await this.audit.record(tx, {
            action: 'tender.updated',
            targetId: id,
            changes,
          });
      })
      .then(() => this.get(id));
  }

  /**
   * Published: it takes bids until its deadline, at least an hour ahead.
   * The invited vendors' contractors are told.
   */
  publish(id: string): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'draft') throw tenderState(before.status);
        const now = await dbNow(tx);
        requireDeadline(before.bidsDueAt, now, true);
        const tender = await tx.tender.update({
          where: { id },
          data: {
            status: 'open',
            publishedById: this.ctx.accountId,
            publishedAt: now,
          },
        });
        const invited = await tx.tenderInvitation.findMany({
          where: { tenderId: id, kind: 'vendor', revokedAt: null },
          select: { vendorId: true },
        });
        await this.audit.record(tx, {
          action: 'tender.published',
          targetId: id,
          metadata: {
            bidsDueAt: tender.bidsDueAt.toISOString(),
            invitations: invited.length,
          },
        });
        for (const i of invited)
          await this.tellInvited(tx, tender, i.vendorId!);
      })
      .then(() => this.get(id));
  }

  /** A later deadline, before the first passes; the bidders are told again. */
  extend(id: string, bidsDueAt: Date): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'open') throw tenderState(before.status);
        const now = await dbNow(tx);
        if (before.bidsDueAt <= now)
          throw appError.conflict(
            ErrorCode.TENDER_CLOSED,
            'The deadline passed: it no longer moves',
            { params: { bidsDueAt: before.bidsDueAt.toISOString() } },
          );
        if (bidsDueAt <= before.bidsDueAt)
          throw invalid([
            {
              field: 'bidsDueAt',
              code: FieldErrorCode.INVALID_VALUE,
              params: { min: before.bidsDueAt.toISOString() },
            },
          ]);
        requireDeadline(bidsDueAt, now, true);
        const tender = await tx.tender.update({
          where: { id },
          data: { bidsDueAt },
        });
        await this.audit.record(tx, {
          action: 'tender.updated',
          targetId: id,
          changes: diffChanges(
            { bidsDueAt: before.bidsDueAt.toISOString() },
            { bidsDueAt: bidsDueAt.toISOString() },
            'tender.updated',
          ),
        });
        const invited = await tx.tenderInvitation.findMany({
          where: { tenderId: id, kind: 'vendor', revokedAt: null },
          select: { vendorId: true },
        });
        for (const i of invited)
          await this.tellInvited(tx, tender, i.vendorId!);
      })
      .then(() => this.get(id));
  }

  /** Called off with a code, any time before the award; bidders are told. */
  cancel(id: string, reasonCode?: string): Promise<TenderRecord> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.tenderCancel);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (!CANCELLABLE.includes(before.status as TenderStatus))
          throw tenderState(before.status);
        const now = await dbNow(tx);
        await tx.tender.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelledById: this.ctx.accountId,
            cancelledAt: now,
            cancelReason: code,
          },
        });
        await this.revokeLinks(tx, id, now);
        await this.audit.record(tx, {
          action: 'tender.cancelled',
          targetId: id,
          metadata: { reasonCode: code, from: before.status },
        });
        if (before.status !== 'draft')
          await this.tellBidders(tx, before, null, 'cancelled');
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Documents
  // --------------------------------------------------------------------------

  addDocument(
    id: string,
    input: { fileId: string; title: string },
  ): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const tender = await this.lock(tx, id);
        await requireTakingBids(tx, tender, true);
        const live = await tx.tenderDocument.count({
          where: { tenderId: id, removedAt: null },
        });
        if (live >= TENDER_LIMITS.documents)
          throw appError.conflict(
            ErrorCode.TENDER_DOCUMENT_LIMIT,
            'A tender holds 20 documents at most',
            { params: { limit: TENDER_LIMITS.documents } },
          );
        const file = await this.files.claim(
          tx,
          input.fileId,
          'tender_document',
        );
        if (!file)
          throw invalid([
            { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        const documentId = newId();
        await tx.tenderDocument.create({
          data: {
            id: documentId,
            tenantId: this.ctx.txTenantId,
            tenderId: id,
            fileId: file.id,
            title: input.title.trim(),
            addedById: this.ctx.accountId,
            addedAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'tender.document_added',
          targetId: id,
          metadata: { documentId },
        });
      })
      .then(() => this.get(id));
  }

  removeDocument(id: string, documentId: string): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const tender = await this.lock(tx, id);
        await requireTakingBids(tx, tender, true);
        const doc = await tx.tenderDocument.findFirst({
          where: { id: documentId, tenderId: id, removedAt: null },
        });
        if (!doc)
          throw appError.notFound(
            ErrorCode.TENDER_DOCUMENT_NOT_FOUND,
            'Document not found',
          );
        await tx.tenderDocument.update({
          where: { id: documentId },
          data: {
            removedById: this.ctx.accountId,
            removedAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'tender.document_removed',
          targetId: id,
          metadata: { documentId },
        });
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Invitations and bid links
  // --------------------------------------------------------------------------

  /** A vendor of the register, not suspended, once among the live ones. */
  inviteVendor(id: string, vendorId: string): Promise<TenderInvitation> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tender = await this.lock(tx, id);
      await requireTakingBids(tx, tender, true);
      await this.requireRoom(tx, id);
      await this.vendors.lockUsable(tx, vendorId);
      const twin = await tx.tenderInvitation.findFirst({
        where: { tenderId: id, vendorId, revokedAt: null },
        select: { id: true },
      });
      if (twin)
        throw appError.conflict(
          ErrorCode.TENDER_ALREADY_INVITED,
          'This vendor is invited already',
          { params: { invitationId: twin.id } },
        );
      const invitation = await tx.tenderInvitation.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          tenderId: id,
          kind: 'vendor',
          vendorId,
          invitedById: this.ctx.accountId,
          invitedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'tender_invitation.created',
        targetId: invitation.id,
        metadata: { tenderId: id, kind: 'vendor', vendorId },
      });
      if (tender.status === 'open')
        await this.tellInvited(tx, tender, vendorId);
      return invitation;
    });
  }

  /**
   * A company that is not registered: its invitation and a bid link, the
   * token shown once (the response is no-store); the compound keeps a hash.
   */
  inviteByLink(
    id: string,
    input: { companyName: string; contactEmail?: string },
  ): Promise<IssuedLink> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tender = await this.lock(tx, id);
      await requireTakingBids(tx, tender, true);
      await this.requireRoom(tx, id);
      const now = await dbNow(tx);
      const invitation = await tx.tenderInvitation.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          tenderId: id,
          kind: 'link',
          companyName: input.companyName.trim(),
          contactEmail: input.contactEmail?.trim().toLowerCase() || null,
          invitedById: this.ctx.accountId,
          invitedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'tender_invitation.created',
        targetId: invitation.id,
        changes: diffChanges(
          null,
          {
            companyName: invitation.companyName,
            contactEmail: invitation.contactEmail,
          },
          'tender_invitation.created',
        ),
        metadata: { tenderId: id, kind: 'link' },
      });
      return this.issue(tx, invitation, now);
    });
  }

  /** A new link for a link invitation; the one before stops at once. */
  rotateLink(id: string, invitationId: string): Promise<IssuedLink> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tender = await this.lock(tx, id);
      await requireTakingBids(tx, tender, true);
      const invitation = await this.lockInvitation(tx, id, invitationId);
      if (invitation.kind !== 'link' || invitation.revokedAt !== null)
        throw invitationNotFound();
      const now = await dbNow(tx);
      await this.globalDb.in(tx).tenderBidLink.updateMany({
        where: { invitationId, revokedAt: null },
        data: { revokedAt: now, revokedById: this.ctx.accountId },
      });
      return this.issue(tx, invitation, now);
    });
  }

  /**
   * Revoked: a registered vendor's contractors no longer see it, a link no
   * longer opens. Its live bid, if any, is withdrawn with it while the
   * tender takes bids; once the deadline passed, the bid stands.
   */
  revoke(id: string, invitationId: string): Promise<TenderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const tender = await this.lock(tx, id);
        await requireTakingBids(tx, tender, true);
        const invitation = await this.lockInvitation(tx, id, invitationId);
        if (invitation.revokedAt !== null) throw invitationNotFound();
        const now = await dbNow(tx);
        await tx.tenderInvitation.update({
          where: { id: invitationId },
          data: { revokedAt: now, revokedById: this.ctx.accountId },
        });
        await this.globalDb.in(tx).tenderBidLink.updateMany({
          where: { invitationId, revokedAt: null },
          data: { revokedAt: now, revokedById: this.ctx.accountId },
        });
        let withdrawn = 0;
        if (tender.status === 'open')
          withdrawn = await tx.$executeRaw`
            UPDATE tender_bids SET withdrawn_at = ${now}
             WHERE invitation_id = ${invitationId}::uuid AND withdrawn_at IS NULL`;
        await this.audit.record(tx, {
          action: 'tender_invitation.revoked',
          targetId: invitationId,
          metadata: { tenderId: id, kind: invitation.kind, withdrawn },
        });
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // The opening
  // --------------------------------------------------------------------------

  /**
   * After the deadline: the first holder of `tenders.open` begins it, the
   * others are asked to confirm; a second, different one confirms it and
   * every live bid is unsealed at that moment. Two at once: one begins it,
   * the other confirms it. The one who began it never confirms it.
   */
  open(id: string): Promise<TenderRecord> {
    const me = this.ctx.accountId;
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        const now = await dbNow(tx);
        if (before.status === 'open') {
          if (before.bidsDueAt > now)
            throw appError.conflict(
              ErrorCode.TENDER_NOT_DUE,
              'The bids are opened after the deadline',
              { params: { bidsDueAt: before.bidsDueAt.toISOString() } },
            );
          await tx.tender.update({
            where: { id },
            data: {
              status: 'opening',
              openingStartedById: me,
              openingStartedAt: now,
            },
          });
          await this.audit.record(tx, {
            action: 'tender.opening_started',
            targetId: id,
            metadata: { startedById: me },
          });
          const others = (await this.staff.holding(tx, 'tenders.open'))
            .map((r) => r.id)
            .filter((r) => r !== me);
          await this.notifier.notify(tx, others, {
            kind: 'tender.opening_started',
            params: { tenderRef: tenderReference(before.number) },
            targetId: id,
          });
          return;
        }
        if (before.status !== 'opening') throw tenderState(before.status);
        if (before.openingStartedById === me)
          throw appError.conflict(
            ErrorCode.TENDER_OPENING_SAME_PERSON,
            'Someone else confirms the opening',
          );
        const bidCount = await tx.tenderBid.count({
          where: { tenderId: id, withdrawnAt: null },
        });
        await tx.tender.update({
          where: { id },
          data: {
            status: 'opened',
            openedById: me,
            openedAt: now,
            bidCount,
          },
        });
        // The seal breaks here and only here: the trigger copies each live
        // bid's amount from the column the app never reads.
        await tx.$executeRaw`
          UPDATE tender_bids SET unsealed_at = ${now}
           WHERE tender_id = ${id}::uuid AND withdrawn_at IS NULL`;
        await this.audit.record(tx, {
          action: 'tender.opened',
          targetId: id,
          metadata: {
            startedById: before.openingStartedById,
            confirmedById: me,
            bidCount,
          },
        });
        await this.notifier.notify(
          tx,
          (await this.staff.holding(tx, 'tenders.manage')).map((r) => r.id),
          {
            kind: 'tender.opened',
            params: { tenderRef: tenderReference(before.number), bidCount },
            targetId: id,
          },
        );
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // The award
  // --------------------------------------------------------------------------

  /**
   * To one opened bid: the compound's contract is signed with its vendor at
   * its amount, in this transaction, under the board's approved major
   * contract above the manager's limit (the contract's own rule, ADR 0077).
   * Two awards at once: the tender's lock lets one through.
   */
  award(id: string, input: AwardInput): Promise<TenderRecord> {
    const me = this.ctx.accountId;
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const tender = await this.lock(tx, id);
        if (tender.status !== 'opened') throw tenderState(tender.status);
        const bid = await tx.tenderBid.findFirst({
          where: { id: input.bidId, tenderId: id },
        });
        if (!bid || bid.withdrawnAt !== null || bid.amount === null)
          throw appError.notFound(
            ErrorCode.TENDER_BID_NOT_FOUND,
            'Bid not found',
          );
        const invitation = await tx.tenderInvitation.findUniqueOrThrow({
          where: { id: bid.invitationId },
        });
        // A link bidder becomes a vendor of the register (found by its
        // name, whatever its case, or registered with it), named on its bid.
        const vendor = invitation.vendorId
          ? await this.vendors.lockUsable(tx, invitation.vendorId)
          : await this.vendors.findOrCreate(tx, invitation.companyName!, null);
        if (!bid.vendorId)
          await tx.tenderBid.update({
            where: { id: bid.id },
            data: { vendorId: vendor.id },
          });
        const contractId = newId();
        await this.contracts.createIn(tx, contractId, {
          code: input.code,
          kind: tender.contractKind as ContractKind,
          vendorId: vendor.id,
          scope: tender.title,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          annualValue: bid.amount.toFixed(2),
          budgetLineId: tender.budgetLineId ?? undefined,
          approvalRequestId: input.approvalRequestId,
        });
        const now = await dbNow(tx);
        await tx.tender.update({
          where: { id },
          data: {
            status: 'awarded',
            awardedBidId: bid.id,
            awardedById: me,
            awardedAt: now,
            contractId,
          },
        });
        await this.audit.record(tx, {
          action: 'tender.awarded',
          targetId: id,
          metadata: {
            bidId: bid.id,
            vendorId: vendor.id,
            amount: bid.amount.toFixed(2),
            contractId,
            approvalRequestId: input.approvalRequestId ?? null,
          },
        });
        await this.tellBidders(tx, tender, vendor.id, 'awarded');
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------

  private async load(tx: TenantTxClient, t: Tender): Promise<TenderRecord> {
    const docs = await tx.tenderDocument.findMany({
      where: { tenderId: t.id, removedAt: null },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    const invitations = await tx.tenderInvitation.findMany({
      where: { tenderId: t.id },
      orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
    });
    const links = new Map(
      (
        await this.globalDb.in(tx).tenderBidLink.findMany({
          where: {
            tenantId: t.tenantId,
            tenderId: t.id,
            revokedAt: null,
          },
          select: { invitationId: true, expiresAt: true },
        })
      ).map((l) => [l.invitationId, l.expiresAt]),
    );
    const bids = await tx.tenderBid.findMany({
      where: { tenderId: t.id },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    });
    const vendorIds = [
      ...invitations.flatMap((i) => (i.vendorId ? [i.vendorId] : [])),
      ...bids.flatMap((b) => (b.vendorId ? [b.vendorId] : [])),
    ];
    const names = new Map(
      (
        await tx.vendor.findMany({
          where: { id: { in: vendorIds } },
          select: { id: true, name: true },
        })
      ).map((v) => [v.id, v.name]),
    );
    const byId = new Map(invitations.map((i) => [i.id, i]));
    const opened = t.openedAt !== null;
    const bidReads: BidRead[] = [];
    for (const b of bids) {
      const invitation = byId.get(b.invitationId)!;
      bidReads.push({
        bid: b,
        invitation,
        vendorName: names.get(b.vendorId ?? invitation.vendorId ?? '') ?? null,
        // Its offer is read only once the tender is opened.
        fileUrl: opened ? await this.files.readUrl(tx, b.fileId) : null,
      });
    }
    const documents = [];
    for (const d of docs)
      documents.push({
        document: d,
        read: await this.files.readUrl(tx, d.fileId),
      });
    return {
      tender: t,
      documents,
      invitations: invitations.map((i) => ({
        invitation: i,
        vendorName: i.vendorId ? (names.get(i.vendorId) ?? null) : null,
        linkExpiresAt: links.get(i.id) ?? null,
      })),
      bids: bidReads,
      contract: t.contractId
        ? await tx.maintenanceContract.findUnique({
            where: { id: t.contractId },
            select: { id: true, code: true },
          })
        : null,
    };
  }

  private async lock(tx: TenantTxClient, id: string): Promise<Tender> {
    await tx.$queryRaw`SELECT id FROM tenders WHERE id = ${id}::uuid FOR UPDATE`;
    const tender = await tx.tender.findUnique({ where: { id } });
    if (!tender) throw tenderNotFound();
    return tender;
  }

  private async lockInvitation(
    tx: TenantTxClient,
    tenderId: string,
    invitationId: string,
  ): Promise<TenderInvitation> {
    await tx.$queryRaw`SELECT id FROM tender_invitations WHERE id = ${invitationId}::uuid FOR UPDATE`;
    const invitation = await tx.tenderInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation || invitation.tenderId !== tenderId)
      throw invitationNotFound();
    return invitation;
  }

  private async requireRoom(tx: TenantTxClient, id: string): Promise<void> {
    const live = await tx.tenderInvitation.count({
      where: { tenderId: id, revokedAt: null },
    });
    if (live >= TENDER_LIMITS.invitations)
      throw invalid([
        {
          field: 'tenderId',
          code: FieldErrorCode.INVALID_VALUE,
          params: { max: TENDER_LIMITS.invitations },
        },
      ]);
  }

  private async requireLine(
    tx: TenantTxClient,
    budgetLineId: string | null,
  ): Promise<void> {
    if (!budgetLineId) return;
    if (
      !(await tx.financeBudgetLine.findUnique({ where: { id: budgetLineId } }))
    )
      throw invalid([
        {
          field: 'budgetLineId',
          code: FieldErrorCode.BUDGET_LINE_NOT_AVAILABLE,
        },
      ]);
  }

  /** A link's token: shown once, its hash kept in the global pointer. */
  private async issue(
    tx: TenantTxClient,
    invitation: TenderInvitation,
    now: Date,
  ): Promise<IssuedLink> {
    const token = newBidToken();
    const expiresAt = new Date(now.getTime() + TENDER_LINK_DAYS * DAY_MS);
    await this.globalDb.in(tx).tenderBidLink.create({
      data: {
        id: newId(),
        tenantId: invitation.tenantId,
        tenderId: invitation.tenderId,
        invitationId: invitation.id,
        tokenHash: bidTokenHash(token),
        createdById: this.ctx.accountId,
        createdAt: now,
        expiresAt,
      },
    });
    return { invitation, url: bidLink(this.appUrl, token), expiresAt };
  }

  private async revokeLinks(
    tx: TenantTxClient,
    tenderId: string,
    now: Date,
  ): Promise<void> {
    await this.globalDb.in(tx).tenderBidLink.updateMany({
      where: { tenantId: this.ctx.txTenantId, tenderId, revokedAt: null },
      data: { revokedAt: now, revokedById: this.ctx.accountId },
    });
  }

  private async tellInvited(
    tx: TenantTxClient,
    tender: Tender,
    vendorId: string,
  ): Promise<void> {
    await this.notifier.notify(
      tx,
      await contractorsOf(tx, vendorId, 'tenders.bid'),
      {
        kind: 'tender.invited',
        params: {
          tenderRef: tenderReference(tender.number),
          bidsDueAt: tender.bidsDueAt.toISOString(),
        },
        targetId: tender.id,
      },
    );
  }

  /** The bidding registered vendors' contractors; a link bidder has no inbox. */
  private async tellBidders(
    tx: TenantTxClient,
    tender: Tender,
    winnerId: string | null,
    outcome: 'awarded' | 'cancelled',
  ): Promise<void> {
    const bidders = await tx.tenderBid.findMany({
      where: { tenderId: tender.id, withdrawnAt: null },
      select: { vendorId: true, invitationId: true },
    });
    const invitations = await tx.tenderInvitation.findMany({
      where: { id: { in: bidders.map((b) => b.invitationId) } },
      select: { vendorId: true },
    });
    const vendors = new Set([
      ...invitations.flatMap((i) => (i.vendorId ? [i.vendorId] : [])),
      ...bidders.flatMap((b) => (b.vendorId ? [b.vendorId] : [])),
    ]);
    for (const vendorId of vendors) {
      const won = vendorId === winnerId;
      await this.notifier.notify(
        tx,
        await contractorsOf(tx, vendorId, 'tenders.bid'),
        {
          kind: 'tender.decided',
          params: {
            tenderRef: tenderReference(tender.number),
            outcome:
              outcome === 'cancelled'
                ? 'cancelled'
                : won
                  ? 'awarded'
                  : 'not_awarded',
          },
          targetId: tender.id,
        },
      );
    }
  }
}

/**
 * A deadline after now, a year ahead at most; at publishing (and when it
 * moves) an hour ahead at least.
 */
function requireDeadline(due: Date, now: Date, publishing: boolean): void {
  const min =
    now.getTime() + (publishing ? TENDER_LIMITS.minLeadMinutes : 0) * MINUTE_MS;
  const max = now.getTime() + TENDER_LIMITS.maxDaysAhead * DAY_MS;
  if (due.getTime() <= min || due.getTime() > max)
    throw invalid([
      {
        field: 'bidsDueAt',
        code: FieldErrorCode.INVALID_VALUE,
        params: {
          min: new Date(min).toISOString(),
          max: new Date(max).toISOString(),
        },
      },
    ]);
}

/**
 * A draft, or a published tender before its deadline (by the database's
 * clock): what documents and invitations may still change.
 */
export async function requireTakingBids(
  tx: TenantTxClient,
  tender: Tender,
  draftToo: boolean,
): Promise<void> {
  if (draftToo && tender.status === 'draft') return;
  if (tender.status !== 'open') throw tenderState(tender.status);
  if (tender.bidsDueAt <= (await dbNow(tx)))
    throw appError.conflict(
      ErrorCode.TENDER_CLOSED,
      'The deadline passed: bids are no longer taken',
      { params: { bidsDueAt: tender.bidsDueAt.toISOString() } },
    );
}

const audited = (t: Tender) => ({
  title: t.title,
  scope: t.scope,
  category: t.category,
  contractKind: t.contractKind,
  budgetLineId: t.budgetLineId,
  estimatedValue:
    t.estimatedValue === null
      ? null
      : new Prisma.Decimal(t.estimatedValue).toFixed(2),
  bidsDueAt: t.bidsDueAt.toISOString(),
});

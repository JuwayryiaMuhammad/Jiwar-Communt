import { Injectable } from '@nestjs/common';
import type { SafetyAcknowledgement, SafetyInstruction } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';
import { acknowledgementDigest, INSTRUCTION_MAX } from './safety-rules';

export interface TicketSafety {
  /** The category's current instructions, if it has any. */
  instruction: SafetyInstruction | null;
  /** The caller's acknowledgement of them for this ticket's cycle. */
  acknowledgement: SafetyAcknowledgement | null;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid instructions', {
    fields,
  });
const categoryNotFound = () =>
  appError.notFound(ErrorCode.TICKET_CATEGORY_NOT_FOUND, 'Category not found');

/**
 * A ticket category's safety instructions (ADR 0067), kept with
 * `safety.manage`: each change is the next version, and a version never
 * changes. A technician acknowledges the current version for a ticket and
 * its cycle before the work starts; the acknowledgement stores the hash of
 * exactly what they were shown (acknowledgementDigest), once.
 *
 * Locks: a new version takes the category's row FOR UPDATE, so versions are
 * numbered one at a time; an acknowledgement takes the ticket's lock, as a
 * start does.
 */
@Injectable()
export class SafetyInstructionsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly audit: AuditService,
  ) {}

  /** A category's versions, the latest first. */
  versions(categoryId: string): Promise<SafetyInstruction[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireCategory(tx, categoryId);
      return tx.safetyInstruction.findMany({
        where: { categoryId },
        orderBy: { version: 'desc' },
      });
    });
  }

  /** The next version of a category's instructions. */
  publish(
    categoryId: string,
    input: { textEn: string; textAr: string },
  ): Promise<SafetyInstruction> {
    const textEn = input.textEn.trim();
    const textAr = input.textAr.trim();
    const fields: FieldError[] = (
      [
        ['textEn', textEn],
        ['textAr', textAr],
      ] as const
    )
      .filter(([, t]) => !t)
      .map(([field]) => ({
        field,
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: INSTRUCTION_MAX },
      }));
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM ticket_categories WHERE id = ${categoryId}::uuid FOR UPDATE`;
      const category = await this.requireCategory(tx, categoryId);
      const last = await tx.safetyInstruction.findFirst({
        where: { categoryId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;
      const instruction = await tx.safetyInstruction.create({
        data: {
          id: newId(),
          tenantId: category.tenantId,
          categoryId,
          version,
          textEn,
          textAr,
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'safety_instruction.published',
        targetId: instruction.id,
        metadata: { categoryId, version },
      });
      return instruction;
    });
  }

  /** The technician's own ticket: its category's current version, and theirs. */
  forTicket(ticketId: string): Promise<TicketSafety> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, ticketId, 'technician');
      const instruction = await this.current(tx, ticket.categoryId);
      return {
        instruction,
        acknowledgement: instruction
          ? await tx.safetyAcknowledgement.findFirst({
              where: {
                instructionId: instruction.id,
                accountId: this.ctx.accountId,
                ticketId,
                cycle: ticket.cycle,
              },
            })
          : null,
      };
    });
  }

  /**
   * The technician acknowledges `instructionId` for their own ticket's
   * cycle: it must be the category's current version. Once; again is the
   * same acknowledgement.
   */
  acknowledge(
    ticketId: string,
    instructionId: string,
  ): Promise<SafetyAcknowledgement> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      const current = await this.current(tx, ticket.categoryId);
      if (!current)
        throw appError.notFound(
          ErrorCode.SAFETY_INSTRUCTION_NOT_FOUND,
          'This ticket’s category has no safety instructions',
        );
      if (current.id !== instructionId)
        throw appError.conflict(
          ErrorCode.SAFETY_INSTRUCTION_NOT_CURRENT,
          'Acknowledge the current instructions',
          { params: { instructionId: current.id, version: current.version } },
        );
      const where = {
        instructionId,
        accountId: this.ctx.accountId,
        ticketId,
        cycle: ticket.cycle,
      };
      const now = await dbNow(tx);
      const inserted = await tx.$executeRaw`
        INSERT INTO safety_acknowledgements
          (id, tenant_id, instruction_id, account_id, ticket_id, cycle,
           content_sha256, acknowledged_at)
        VALUES (${newId()}::uuid, ${ticket.tenantId}::uuid, ${instructionId}::uuid,
                ${this.ctx.accountId}::uuid, ${ticketId}::uuid, ${ticket.cycle},
                ${acknowledgementDigest({ ...current, instructionId, accountId: this.ctx.accountId, ticketId, cycle: ticket.cycle })},
                ${now})
        ON CONFLICT DO NOTHING`;
      const ack = await tx.safetyAcknowledgement.findFirstOrThrow({ where });
      if (inserted)
        await this.audit.record(tx, {
          action: 'safety_instruction.acknowledged',
          targetId: instructionId,
          metadata: {
            ticketId,
            cycle: ticket.cycle,
            version: current.version,
            contentSha256: ack.contentSha256,
          },
        });
      return ack;
    });
  }

  private current(
    tx: TenantTxClient,
    categoryId: string,
  ): Promise<SafetyInstruction | null> {
    return tx.safetyInstruction.findFirst({
      where: { categoryId },
      orderBy: { version: 'desc' },
    });
  }

  private async requireCategory(tx: TenantTxClient, id: string) {
    const category = await tx.ticketCategory.findUnique({ where: { id } });
    if (!category) throw categoryNotFound();
    return category;
  }
}

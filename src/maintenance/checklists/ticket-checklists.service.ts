import { Injectable, type OnModuleInit } from '@nestjs/common';
import { appError, ErrorCode } from '../../core/common/errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { assertCan } from '../tickets/ticket-rules';
import { TicketAccess, type Audience } from '../tickets/ticket-access';
import { WorkService } from '../tickets/work.service';
import { ChecklistRuns, runNotFound, type RunRead } from './checklist-runs';
import type { AnswerInput } from './checklist-rules';

/**
 * A ticket's checklist (ADR 0064): a planned job's, opened with its work
 * order, of the ticket's cycle. The technician answers it while working
 * (in progress or on hold) and submits it; the ticket is not completed
 * while it is open (409 CHECKLIST_NOT_SUBMITTED). Dispatch reads it.
 *
 * Lock order: the technician's account (shared), the ticket, the run.
 */
@Injectable()
export class TicketChecklists implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: TicketAccess,
    private readonly runs: ChecklistRuns,
    private readonly work: WorkService,
  ) {}

  onModuleInit(): void {
    this.work.onCompleting(async (tx, ticket) => {
      const run = await this.runs.lockOfTicket(tx, ticket.id, ticket.cycle);
      if (run?.status === 'open')
        throw appError.conflict(
          ErrorCode.CHECKLIST_NOT_SUBMITTED,
          'Submit the checklist first',
        );
    });
  }

  read(
    ticketId: string,
    audience: Extract<Audience, 'technician' | 'dispatch'>,
  ): Promise<RunRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, ticketId, audience);
      const run = await this.runs.ofTicket(tx, ticket.id, ticket.cycle);
      if (!run) throw runNotFound();
      return this.runs.read(tx, run);
    });
  }

  answer(
    ticketId: string,
    itemId: string,
    input: AnswerInput & { photoFileIds?: string[] },
  ): Promise<RunRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      assertCan(ticket, 'workPhoto');
      const run = await this.runs.lockOfTicket(tx, ticket.id, ticket.cycle);
      if (!run) throw runNotFound();
      await this.runs.answer(tx, run, itemId, input);
      return this.runs.read(tx, run);
    });
  }

  submit(ticketId: string): Promise<RunRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      assertCan(ticket, 'workPhoto');
      const run = await this.runs.lockOfTicket(tx, ticket.id, ticket.cycle);
      if (!run) throw runNotFound();
      const { run: submitted } = await this.runs.submit(tx, run);
      return this.runs.read(tx, submitted);
    });
  }
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';

/**
 * The guard duty section of a personal-data export (ADR 0050),
 * `guard-duty/`, for a guard: their own shifts (where, when, lateness,
 * overtime or unscheduled minutes), their slots, their swaps (the reason
 * when they asked), their handovers (what they ticked and wrote), the tasks
 * they took (the outcome and their note), the instructions that reached
 * them (when, and when they acknowledged), and the items they registered.
 * Posts by name; never another guard's name or words.
 */
@Injectable()
export class GuardDutyExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('guard_duty', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const d = await this.tenantTx.withTenantTx(async (tx) => {
      const shifts = await tx.guardShift.findMany({
        where: { guardAccountId: me },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      });
      const slots = await tx.guardRosterSlot.findMany({
        where: { guardAccountId: me },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
      const filled = new Map(
        (
          await tx.guardRosterSlot.findMany({
            where: { shiftId: { in: shifts.map((x) => x.id) } },
            select: { shiftId: true, startsAt: true, lateMinutes: true },
          })
        ).map((x) => [x.shiftId!, x]),
      );
      const swaps = await tx.guardShiftSwap.findMany({
        where: { OR: [{ requesterId: me }, { colleagueId: me }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const handovers = await tx.guardHandover.findMany({
        where: { guardAccountId: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const tasks = await tx.guardTask.findMany({
        where: { takenById: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const reached = await tx.guardInstructionRecipient.findMany({
        where: { accountId: me },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      });
      const instructions = new Map(
        (
          await tx.guardInstruction.findMany({
            where: { id: { in: reached.map((r) => r.instructionId) } },
            select: { id: true, title: true, urgent: true },
          })
        ).map((i) => [i.id, i]),
      );
      const found = await tx.foundItem.findMany({
        where: { registeredById: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const posts = [...shifts, ...slots, ...handovers];
      const gates = new Map(
        (
          await tx.gate.findMany({
            where: {
              id: { in: posts.flatMap((p) => (p.gateId ? [p.gateId] : [])) },
            },
            select: { id: true, name: true },
          })
        ).map((g) => [g.id, g.name]),
      );
      const zones = new Map(
        (
          await tx.place.findMany({
            where: {
              id: { in: posts.flatMap((p) => (p.placeId ? [p.placeId] : [])) },
            },
            select: { id: true, nameEn: true },
          })
        ).map((z) => [z.id, z.nameEn]),
      );
      return {
        shifts,
        filled,
        slots,
        swaps,
        handovers,
        tasks,
        reached,
        instructions,
        found,
        gates,
        zones,
      };
    });
    const post = (p: { gateId: string | null; placeId: string | null }) =>
      p.gateId
        ? { gate: d.gates.get(p.gateId) ?? null }
        : { zone: d.zones.get(p.placeId!) ?? null };
    yield {
      path: 'guard-duty/shifts.json',
      json: d.shifts.map((x) => ({
        ...post(x),
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        endReason: x.endReason,
        scheduledStart: d.filled.get(x.id)?.startsAt ?? null,
        lateMinutes: d.filled.get(x.id)?.lateMinutes ?? null,
        overtimeMinutes: x.overtimeMinutes,
        unscheduledMinutes: x.unscheduledMinutes,
      })),
    };
    yield {
      path: 'guard-duty/roster.json',
      json: d.slots.map((x) => ({
        ...post(x),
        startsAt: x.startsAt,
        endsAt: x.endsAt,
        status: x.status,
        cancelReason: x.cancelReason,
        absentAt: x.absentAt,
        swappedAt: x.swappedAt,
      })),
    };
    yield {
      path: 'guard-duty/swaps.json',
      json: d.swaps.map((x) => ({
        role: x.requesterId === me ? 'requester' : 'colleague',
        status: x.status,
        reason: x.requesterId === me ? x.reason : null,
        createdAt: x.createdAt,
        acceptedAt: x.acceptedAt,
        decidedAt: x.decidedAt,
        rejectReason: x.rejectReason,
        closeReason: x.closeReason,
      })),
    };
    yield {
      path: 'guard-duty/handovers.json',
      json: d.handovers.map((x) => ({
        ...post(x),
        kind: x.kind,
        checklist: (x.checklist as { label: string }[]).map((c) => c.label),
        notes: x.notes,
        createdAt: x.createdAt,
        acknowledgedAt: x.acknowledgedAt,
      })),
    };
    yield {
      path: 'guard-duty/tasks.json',
      json: d.tasks.map((x) => ({
        kind: x.kind,
        title: x.title,
        status: x.status,
        takenAt: x.takenAt,
        doneAt: x.doneAt,
        outcome: x.outcome,
        resultNote: x.resultNote,
      })),
    };
    yield {
      path: 'guard-duty/instructions.json',
      json: d.reached.map((r) => ({
        title: d.instructions.get(r.instructionId)?.title ?? null,
        urgent: d.instructions.get(r.instructionId)?.urgent ?? false,
        reachedAt: r.addedAt,
        acknowledgedAt: r.acknowledgedAt,
      })),
    };
    yield {
      path: 'guard-duty/found-items.json',
      json: d.found.map((x) => ({
        description: x.description,
        foundAt: x.foundAt,
        status: x.status,
        createdAt: x.createdAt,
      })),
    };
  }
}

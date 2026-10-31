import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/common/cls/request-context';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { gateBusyLevels, type GateBusyLevel } from './gate-busy';

/** A gate as an occupant sees it: its name, whether it is in service, how busy. */
export interface GateStatus {
  id: string;
  name: string;
  open: boolean;
  /** Entries in the last fifteen minutes, as a level (ADR 0071). */
  busy: GateBusyLevel;
}

/**
 * What another domain reads of the gates (ADR 0015, 0040): which exist and
 * whether each is in service, as `GET /gates/status` tells an occupant.
 * Never who is on duty, never an entry. Every method takes the caller's
 * transaction.
 */
@Injectable()
export class GateStatusPort {
  constructor(private readonly ctx: RequestContext) {}

  /** Every gate, by name (a compound has a handful). */
  async statuses(tx: TenantTxClient): Promise<GateStatus[]> {
    const gates = await tx.gate.findMany({
      select: { id: true, name: true, status: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const busy = await gateBusyLevels(tx, this.ctx.txTenantId);
    return gates.map((g) => ({
      id: g.id,
      name: g.name,
      open: g.status === 'active',
      busy: busy.get(g.id) ?? 'quiet',
    }));
  }

  /** Whether the gate is one of the compound's. */
  async exists(tx: TenantTxClient, gateId: string): Promise<boolean> {
    return (
      (await tx.gate.findUnique({
        where: { id: gateId },
        select: { id: true },
      })) !== null
    );
  }
}

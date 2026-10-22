import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PartnerRequest } from '@prisma/client';
import { GatePartnersPort, type ServicePass } from '../../gate';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { PartnerRequestEngine, type RequestActor } from './request-engine';
import type { RequestAction } from './request-rules';

/** The pass lets the partner's staff in from this long before the window… */
export const PASS_EARLY_MS = 30 * 60_000;
/** …until this long after it. */
export const PASS_LATE_MS = 60 * 60_000;
/** A desk shows the pass's link from this long before the window starts (ADR 0060). */
export const DESK_PASS_FROM_MS = 2 * 3_600_000;

/**
 * The partner's service pass (ADR 0060 §3). An accepted request that asked
 * for one gives the partner's staff a one-time visitor pass for the agreed
 * window (from half an hour before to an hour after), in the requester's
 * name, for as many as the partner said would come: the gate's own pass,
 * in the same transaction as the acceptance, after the partners' locks.
 * When the requester may no longer invite visitors or the unit has no room
 * for another pass, the acceptance stands and the pass is skipped (the
 * guard asks the household, as for anyone uninvited). A request cancelled
 * after its acceptance cancels its pass.
 */
@Injectable()
export class PartnerPasses implements OnModuleInit {
  constructor(
    private readonly gate: GatePartnersPort,
    private readonly engine: PartnerRequestEngine,
  ) {}

  onModuleInit(): void {
    this.engine.onAfter((tx, before, after, action, actor, now) =>
      this.react(tx, before, after, action, actor, now),
    );
  }

  private async react(
    tx: TenantTxClient,
    before: PartnerRequest,
    after: PartnerRequest,
    action: RequestAction,
    actor: RequestActor,
    now: Date,
  ): Promise<void> {
    if (
      (action === 'accept' || action === 'accept_proposal') &&
      after.gatePass &&
      after.passId === null
    ) {
      const partner = await tx.partner.findUniqueOrThrow({
        where: { id: after.partnerId },
        select: { nameAr: true },
      });
      const result = await this.gate.issueServicePass(tx, {
        hostAccountId: after.requesterId,
        unitId: after.unitId,
        validFrom: new Date(
          Math.max(
            now.getTime(),
            after.agreedStartsAt!.getTime() - PASS_EARLY_MS,
          ),
        ),
        validUntil: new Date(after.agreedEndsAt!.getTime() + PASS_LATE_MS),
        partySize: after.staffCount ?? 1,
        visitorName: partner.nameAr,
      });
      if ('passId' in result) {
        await tx.partnerRequest.update({
          where: { id: after.id },
          data: { passId: result.passId },
        });
        await this.engine.event(tx, after, 'pass_issued', actor, now);
      } else
        await this.engine.event(tx, after, 'pass_skipped', actor, now, {
          reasonCode: result.skipped,
        });
      return;
    }
    if (
      after.status === 'cancelled' &&
      before.status === 'accepted' &&
      before.passId !== null
    ) {
      await this.gate.cancelServicePass(tx, before.passId);
      await this.engine.event(tx, after, 'pass_cancelled', actor, now);
    }
  }
}

/**
 * Whether a desk (or the relay) may show a request's service pass now:
 * only while the category's consent holds, from two hours before the
 * agreed window starts until it ends (ADR 0060, the rule on desk
 * exposure). Outside that, nothing of the pass.
 */
export function passOnDesk(
  r: {
    passId: string | null;
    agreedStartsAt: Date | null;
    agreedEndsAt: Date | null;
  },
  consented: boolean,
  now: Date,
): boolean {
  const t = now.getTime();
  return (
    r.passId !== null &&
    consented &&
    r.agreedStartsAt !== null &&
    r.agreedEndsAt !== null &&
    t >= r.agreedStartsAt.getTime() - DESK_PASS_FROM_MS &&
    t < r.agreedEndsAt.getTime()
  );
}

/** The passes a desk shows, by request: shown now and still active. */
export async function deskPasses(
  gate: GatePartnersPort,
  tx: TenantTxClient,
  rows: readonly {
    id: string;
    passId: string | null;
    agreedStartsAt: Date | null;
    agreedEndsAt: Date | null;
  }[],
  consented: ReadonlySet<string>,
  now: Date,
): Promise<Map<string, ServicePass>> {
  const out = new Map<string, ServicePass>();
  for (const r of rows) {
    if (!passOnDesk(r, consented.has(r.id), now)) continue;
    const pass = await gate.servicePass(tx, r.passId!);
    if (pass?.status === 'active') out.set(r.id, pass);
  }
  return out;
}

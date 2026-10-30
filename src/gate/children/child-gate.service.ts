import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ChildControl,
  ChildEscort,
  ChildPickupMethod,
  ChildPickupOutcome,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import { isAdult } from '../../core/common/egyptian-national-id';
import { appError, ErrorCode } from '../../core/common/errors';
import { firstNameOf } from '../../core/common/http/personal';
import { localParts } from '../../core/common/slots/day-slots';
import type { WeeklySchedule } from '../../core/common/slots/weekly-schedule';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import { parseEntryQr } from '../entry/entry-secrets';
import { ResidentVerifier } from '../entry/resident-verifier';
import { LockdownCore } from '../lockdown/lockdown-core';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService, type DutyShift } from '../shifts/shifts.service';
import { ChildCore } from './child-core';
import { engagementWorks } from './child-escorts.service';
import {
  PICKUP_DEDUP_MINUTES,
  validNow,
  validToday,
  type EscortValidity,
} from './child-rules';
import {
  childCardHash,
  childCardMatches,
  parseChildCard,
  parsePickupQr,
} from './child-tokens';
import { ChildExitView, ChildVerifyView } from './views/child-gate.views';

/** The idempotency resource of a recorded exit. */
export const CHILD_EXIT_RESOURCE = 'child_exit';

const MINUTE = 60_000;

const cardUnknown = () =>
  appError.notFound(ErrorCode.CHILD_CARD_UNKNOWN, 'Unknown child card');
const escortUnknown = () =>
  appError.unprocessable(
    ErrorCode.CHILD_ESCORT_UNKNOWN,
    'Nobody can be told from this credential',
  );

/** Who the guard scanned or typed, before any control is locked. */
type Credential =
  | { kind: 'account'; accountId: string; method: ChildPickupMethod }
  | { kind: 'engagement'; engagementId: string; method: ChildPickupMethod }
  | { kind: 'escort'; escortId: string; method: ChildPickupMethod }
  | { kind: 'alone'; method: 'alone' }
  | { kind: 'unidentified'; method: 'unidentified' };

export interface ExitInput {
  card: string;
  escort: { qr?: string; code?: string; alone?: true; unidentified?: true };
}

const ofDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The gate's side of a child's exit control (ADR 0054), for a guard on
 * shift at a gate or a zone. Two scans, own endpoints, apart from
 * `/gate/verify` and sharing its per-guard budget:
 *
 * 1. **The child's card** (`verify`): the child's first name and photo,
 *    whether they may leave alone, and the escorts who may collect them
 *    today (first names, photos, whether now and here). Writes nothing.
 * 2. **The exit** (`exit`): the escort's credential — a resident's QR, a
 *    worker's card or code, an outside person's pickup QR or code — or
 *    "alone", or "unidentified". Authorized → recorded; refused → recorded
 *    as an alert to the household adults and the roster's keepers
 *    (`child.unauthorized_pickup`); alone without leave → recorded, and the
 *    household adults are told (`child.exit_alone`); an authorized exit is
 *    told to them when the household asks (`child.picked_up`).
 *
 * **Lock order of an exit:** the guard's account (FOR SHARE), their open
 * shift (FOR SHARE), the compound's lockdown row (FOR SHARE); then the
 * escort's credential is resolved with plain
 * reads; then the accounts that may be told (the household adults and the
 * roster's keepers, FOR KEY SHARE in id order: what a notification's row
 * would take); then the child's control (FOR UPDATE, read again), the
 * matching escort (FOR SHARE), and the escort's eligibility read again,
 * plainly. No account row and no unit row is locked after the control: the
 * hooks that revoke an escort hold the account first and the control after
 * it.
 *
 * Under a live lockdown of the guard's gate, or of all (ADR 0053), an
 * outside escort is refused (`lockdown`): the household is told, not the
 * keepers. The exit takes the lockdown row FOR SHARE after the shift.
 *
 * Two exits of one child at once serialize on the control: within five
 * minutes of an authorized exit, the same escort replays it and any other
 * is 409 CHILD_JUST_PICKED_UP. A refused attempt never blocks a valid one.
 */
@Injectable()
export class ChildGateService implements OnModuleInit {
  private readonly perMinute: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly core: ChildCore,
    private readonly community: CommunityGatePort,
    private readonly safety: SafetyCore,
    private readonly shifts: ShiftsService,
    private readonly rateLimit: RateLimitService,
    private readonly residents: ResidentVerifier,
    private readonly tokens: AccessTokens,
    private readonly hasher: IdentifierHasher,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly lockdown: LockdownCore,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
  }

  onModuleInit(): void {
    this.idempotency.renderer(CHILD_EXIT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const pickup = await tx.childPickup.findUnique({ where: { id } });
        if (!pickup) throw cardUnknown();
        return this.exitView(tx, pickup);
      }),
    );
  }

  /** The child's card: who they are and who may collect them today. */
  verify(card: string): Promise<ChildVerifyView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOnDuty(tx);
      await this.budget();
      const control = await this.byCard(tx, card, false);
      if (!control) throw cardUnknown();
      const [minor] = [
        ...(await this.community.minorsById(tx, [control.memberId])).values(),
      ];
      const now = await dbNow(tx);
      const timeZone = await this.core.timeZone(tx);
      const today = ofDate(await this.core.today(tx));
      const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
      const escorts = await tx.childEscort.findMany({
        where: { controlId: control.id, revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      // A live lockdown of the guard's gate (ADR 0053): an outside escort
      // takes no child out now (a plain read: verify decides nothing).
      const lockedDown =
        shift.gateId !== null &&
        (await this.lockdown.live(tx, shift.gateId)) !== null;
      const shown: ChildVerifyView['escorts'] = [];
      for (const e of escorts) {
        const v = validityOf(e);
        if (!validToday(v, today, weekday)) continue;
        const who = await this.whoIs(tx, e, now);
        if (!who.eligible) continue;
        shown.push({
          id: e.id,
          kind: e.kind,
          firstName: who.firstName,
          photoUrl:
            (await this.files.readUrl(tx, who.photoFileId))?.url ?? null,
          validNow:
            !(lockedDown && e.kind === 'outside') &&
            validNow(v, { today, instant: now, timeZone, post: shift }) ===
              'ok',
        });
      }
      return {
        result: 'valid',
        child: {
          firstName: firstNameOf(minor?.fullName ?? null) ?? '',
          photoUrl:
            (await this.files.readUrl(tx, control.photoFileId))?.url ?? null,
          mayLeaveAlone: control.mayLeaveAlone,
        },
        escorts: shown,
      };
    });
  }

  /** The exit: authorized, or refused and alerted; recorded either way. */
  exit(input: ExitInput): Promise<{ view: ChildExitView; replay: boolean }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CHILD_EXIT_RESOURCE, id });
      await this.safety.lockSelf(tx);
      // The shift FOR SHARE: its end waits for the exit.
      const shift = await this.shifts.requireOnDutyLocked(tx);
      // The compound's lockdown row, FOR SHARE (ADR 0053's order: the
      // account, the shift, this row, then the subject's): a lockdown start
      // waits for this exit, or this exit sees it.
      await this.lockdown.lockState(tx, 'share');
      await this.budget();
      // The credential first, with plain reads: no lock on anyone's account.
      const credential = await this.credential(tx, input.escort);
      // Whoever may be told, before the control: a notification's row keys
      // its account (FOR KEY SHARE), and a deactivation that holds that
      // account waits on the control after it. Taken here, in id order, the
      // two never wait on each other in a cycle.
      const seen = await this.byCard(tx, input.card, false);
      if (!seen) throw cardUnknown();
      const told = await this.lockRecipients(tx, seen.unitId);
      const control = await this.byCard(tx, input.card, true);
      if (!control || control.id !== seen.id) throw cardUnknown();
      const now = await dbNow(tx);

      const match = await this.matching(tx, control, credential);
      const recent = await tx.childPickup.findFirst({
        where: {
          controlId: control.id,
          outcome: { in: ['picked_up', 'left_alone'] },
          at: { gte: new Date(now.getTime() - PICKUP_DEDUP_MINUTES * MINUTE) },
        },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
      });
      if (recent) {
        const same =
          (credential.kind === 'alone' && recent.outcome === 'left_alone') ||
          (match !== null && recent.escortId === match.id);
        if (same)
          return { view: await this.exitView(tx, recent), replay: true };
        throw appError.conflict(
          ErrorCode.CHILD_JUST_PICKED_UP,
          'The child left with someone else a moment ago',
          { params: { minutes: PICKUP_DEDUP_MINUTES } },
        );
      }

      const decided = await this.decide(tx, control, credential, match, {
        now,
        shift,
      });
      const pickup = await tx.childPickup.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          controlId: control.id,
          unitId: control.unitId,
          escortId: decided.escort?.id ?? null,
          escortKind: decided.escort?.kind ?? null,
          outcome: decided.outcome,
          method: credential.method,
          refusalReason: decided.reason,
          guardAccountId: this.ctx.accountId,
          shiftId: shift.id,
          gateId: shift.gateId,
          placeId: shift.placeId,
          at: now,
        },
      });
      // The record's id and codes only: never the child, the control, the
      // unit or the escort (ADR 0054).
      await this.audit.record(tx, {
        action: 'child_pickup.recorded',
        targetId: pickup.id,
        metadata: {
          outcome: pickup.outcome,
          method: pickup.method,
          ...(pickup.refusalReason ? { reasonCode: pickup.refusalReason } : {}),
        },
      });
      await this.tell(tx, control, pickup, told);
      return { view: await this.exitView(tx, pickup), replay: false };
    });
  }

  /**
   * A child's exit a guard device recorded offline (ADR 0057), at sync, in
   * the upload's transaction (the account, the bundle's shift, the device
   * and the lockdown row held): recorded at its device time by the bundle's
   * guard, never refused for being late, as it happened.
   *
   * - Held offline (`released: false`): alone without leave is
   *   `alone_refused`; anyone else the device would not release is refused
   *   `offline_unverified`, the household told (not the keepers: it is the
   *   rule offline).
   * - Released alone: `left_alone`, unless leave was revoked since.
   * - Released with a household adult (the guard checked their ID): their
   *   resident QR is checked now, against the exit's instant (its step
   *   within one either way), and they must be this child's escort, valid
   *   then and there. Then `picked_up`.
   * - Otherwise `left_unverified` with why (`escort_qr_invalid`,
   *   `not_an_escort`, `escort_inactive`, `outside_validity`, `wrong_post`,
   *   `alone_not_allowed`): the household and the keepers alerted, and a
   *   security flag for the batch.
   *
   * Lock order after the caller's: the accounts that may be told (FOR KEY
   * SHARE, in id order), the control (FOR UPDATE), the escort (FOR SHARE).
   */
  async recordOffline(
    tx: TenantTxClient,
    a: {
      clientId: string;
      controlId: string;
      escort: 'alone' | 'adult' | 'other';
      released: boolean;
      qr: string | null;
    },
    c: { occurredAt: Date; gateId: string; shiftId: string; guardId: string },
  ): Promise<
    | { pickupId: string; unverified: string | null }
    | { rejection: 'subject_unknown' }
  > {
    const seen = await tx.childControl.findUnique({
      where: { id: a.controlId },
      select: { id: true, unitId: true },
    });
    if (!seen) return { rejection: 'subject_unknown' };
    const told = await this.lockRecipients(tx, seen.unitId);
    const control = (await this.core.lock(tx, seen.id))!;
    const tenantId = this.ctx.txTenantId;
    let outcome: ChildPickupOutcome;
    let reason: string | null = null;
    let method: ChildPickupMethod =
      a.escort === 'alone'
        ? 'alone'
        : a.escort === 'adult'
          ? 'resident_qr'
          : 'unidentified';
    let escort: ChildEscort | null = null;
    if (!a.released) {
      if (a.escort === 'alone') {
        outcome = 'alone_refused';
        reason = 'alone_not_allowed';
      } else {
        outcome = 'refused';
        reason = 'offline_unverified';
        method = 'unidentified';
      }
    } else if (a.escort === 'alone') {
      outcome = control.mayLeaveAlone ? 'left_alone' : 'left_unverified';
      if (!control.mayLeaveAlone) reason = 'alone_not_allowed';
    } else {
      const qr = a.qr ? parseEntryQr(a.qr) : null;
      const found = qr
        ? await this.residents.identify(
            tx,
            tenantId,
            qr,
            c.occurredAt.getTime(),
          )
        : ({ kind: 'unknown' } as const);
      if (found.kind === 'unknown') reason = 'escort_qr_invalid';
      else if (found.kind === 'refused')
        reason =
          found.reason === 'expired_qr'
            ? 'escort_qr_invalid'
            : 'escort_inactive';
      else {
        escort = await this.matching(tx, control, {
          kind: 'account',
          accountId: found.accountId,
          method: 'resident_qr',
        });
        const decided = await this.decide(
          tx,
          control,
          {
            kind: 'account',
            accountId: found.accountId,
            method: 'resident_qr',
          },
          escort,
          {
            now: c.occurredAt,
            shift: {
              id: c.shiftId,
              guardAccountId: c.guardId,
              gateId: c.gateId,
              placeId: null,
              startedAt: c.occurredAt,
            },
            // Its own compound day: the escort's days are judged then.
            today: localParts(c.occurredAt, await this.core.timeZone(tx)).date,
          },
        );
        if (decided.outcome !== 'picked_up') reason = decided.reason;
      }
      outcome = reason === null ? 'picked_up' : 'left_unverified';
    }
    const pickup = await tx.childPickup.create({
      data: {
        id: a.clientId,
        tenantId,
        controlId: control.id,
        unitId: control.unitId,
        escortId: escort?.id ?? null,
        escortKind: escort?.kind ?? null,
        outcome,
        method,
        refusalReason: reason,
        guardAccountId: c.guardId,
        shiftId: c.shiftId,
        gateId: c.gateId,
        placeId: null,
        at: c.occurredAt,
      },
    });
    await this.audit.record(tx, {
      action: 'child_pickup.recorded',
      targetId: pickup.id,
      metadata: {
        outcome: pickup.outcome,
        method: pickup.method,
        ...(pickup.refusalReason ? { reasonCode: pickup.refusalReason } : {}),
        offline: true,
      },
    });
    await this.tell(tx, control, pickup, told);
    return {
      pickupId: pickup.id,
      unverified: outcome === 'left_unverified' ? reason : null,
    };
  }

  // --------------------------------------------------------------------------

  /** One budget with `/gate/verify`: the guard's scans per minute. */
  private budget(): Promise<void> {
    return this.rateLimit
      .consume(`gate-verify:account:${this.ctx.accountId}`, this.perMinute, 60)
      .then(() => undefined);
  }

  /**
   * The live control behind a scanned card, of a child still under 18 by
   * the compound's day; FOR UPDATE when `lock`, and then read again under
   * it (a reissue or an end that won the lock leaves nothing). Null is the
   * unknown answer, whatever the reason.
   */
  private async byCard(
    tx: TenantTxClient,
    raw: string,
    lock: boolean,
  ): Promise<ChildControl | null> {
    const token = parseChildCard(raw);
    if (!token) return null;
    const tenantId = this.ctx.txTenantId;
    const found = await tx.childControl.findFirst({
      where: { cardTokenHash: childCardHash(tenantId, token), endedAt: null },
    });
    if (!found) return null;
    const control = lock ? await this.core.lock(tx, found.id) : found;
    if (
      !control ||
      control.endedAt ||
      !control.cardTokenHash ||
      !childCardMatches(control.cardTokenHash, tenantId, token)
    )
      return null;
    const member = (
      await this.community.minorsById(tx, [control.memberId])
    ).get(control.memberId);
    if (
      !member?.active ||
      member.unitId !== control.unitId ||
      isAdult(member.birthDate, await this.core.today(tx))
    )
      return null;
    return control;
  }

  /** Who the credential names, as of now; 422 when nobody can be told. */
  private async credential(
    tx: TenantTxClient,
    escort: ExitInput['escort'],
  ): Promise<Credential> {
    if (escort.alone) return { kind: 'alone', method: 'alone' };
    if (escort.unidentified)
      return { kind: 'unidentified', method: 'unidentified' };
    const tenantId = this.ctx.txTenantId;
    if (escort.qr !== undefined) {
      const resident = parseEntryQr(escort.qr);
      if (resident) {
        const found = await this.residents.identify(tx, tenantId, resident);
        if (found.kind !== 'ok') throw escortUnknown();
        return {
          kind: 'account',
          accountId: found.accountId,
          method: 'resident_qr',
        };
      }
      const pickup = parsePickupQr(escort.qr);
      if (pickup) {
        const e = await tx.childEscort.findFirst({
          where: {
            pickupQrHash: this.hasher.hashChildPickupQr(tenantId, pickup),
            revokedAt: null,
          },
          select: { id: true },
        });
        if (!e) throw escortUnknown();
        return { kind: 'escort', escortId: e.id, method: 'pickup_qr' };
      }
      const card = this.tokens.parseQr(escort.qr);
      if (card) {
        const e = await this.community.engagementByQr(tx, tenantId, card);
        if (!e) throw escortUnknown();
        return {
          kind: 'engagement',
          engagementId: e.engagementId,
          method: 'worker_qr',
        };
      }
      throw escortUnknown();
    }
    const code = (escort.code ?? '').trim();
    if (/^\d{8}$/.test(code)) {
      const e = await this.community.engagementByCode(tx, tenantId, code);
      if (!e) throw escortUnknown();
      return {
        kind: 'engagement',
        engagementId: e.engagementId,
        method: 'worker_code',
      };
    }
    if (/^\d{6}$/.test(code)) {
      const e = await tx.childEscort.findFirst({
        where: {
          pickupCodeHash: this.hasher.hashChildPickupCode(tenantId, code),
          revokedAt: null,
        },
        select: { id: true },
      });
      if (!e) throw escortUnknown();
      return { kind: 'escort', escortId: e.id, method: 'pickup_code' };
    }
    throw escortUnknown();
  }

  /**
   * The control's escort the credential names: its live one, FOR SHARE;
   * else its latest revoked one (a revocation that won the control's lock:
   * refused as `escort_inactive`); else null (not this child's escort).
   */
  private async matching(
    tx: TenantTxClient,
    control: ChildControl,
    credential: Credential,
  ): Promise<ChildEscort | null> {
    const where =
      credential.kind === 'account'
        ? { accountId: credential.accountId }
        : credential.kind === 'engagement'
          ? { engagementId: credential.engagementId }
          : credential.kind === 'escort'
            ? { id: credential.escortId }
            : null;
    if (!where) return null;
    const live = await tx.childEscort.findFirst({
      where: { controlId: control.id, revokedAt: null, ...where },
      select: { id: true },
    });
    if (live) {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM child_escorts
         WHERE id = ${live.id}::uuid AND revoked_at IS NULL FOR SHARE`;
      if (row)
        return tx.childEscort.findUniqueOrThrow({ where: { id: row.id } });
    }
    return tx.childEscort.findFirst({
      where: { controlId: control.id, revokedAt: { not: null }, ...where },
      orderBy: [{ revokedAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** The outcome, under the control's lock, by the database's clock. */
  private async decide(
    tx: TenantTxClient,
    control: ChildControl,
    credential: Credential,
    escort: ChildEscort | null,
    at: { now: Date; shift: DutyShift; today?: string },
  ): Promise<{
    outcome: ChildPickupOutcome;
    reason: string | null;
    escort: ChildEscort | null;
  }> {
    if (credential.kind === 'alone')
      return control.mayLeaveAlone
        ? { outcome: 'left_alone', reason: null, escort: null }
        : {
            outcome: 'alone_refused',
            reason: 'alone_not_allowed',
            escort: null,
          };
    if (credential.kind === 'unidentified')
      return { outcome: 'refused', reason: 'no_credential', escort: null };
    if (!escort)
      return { outcome: 'refused', reason: 'not_an_escort', escort: null };
    if (escort.revokedAt)
      return { outcome: 'refused', reason: 'escort_inactive', escort };
    // Read again, plainly: a revocation of this escort takes the control
    // first, so it either committed before (revoked above) or waits for us.
    const who = await this.whoIs(tx, escort, at.now);
    if (!who.eligible)
      return { outcome: 'refused', reason: 'escort_inactive', escort };
    const verdict = validNow(validityOf(escort), {
      today: at.today ?? ofDate(await this.core.today(tx)),
      instant: at.now,
      timeZone: await this.core.timeZone(tx),
      post: at.shift,
    });
    if (verdict !== 'ok')
      return { outcome: 'refused', reason: verdict, escort };
    // A live lockdown of this gate, or of all (ADR 0053): nobody from
    // outside takes a child out. The household's adults and the unit's
    // workers live or work here and still may.
    if (
      escort.kind === 'outside' &&
      at.shift.gateId !== null &&
      (await this.lockdown.live(tx, at.shift.gateId))
    )
      return { outcome: 'refused', reason: 'lockdown', escort };
    return { outcome: 'picked_up', reason: null, escort };
  }

  /**
   * Whether the escort can collect a child now, and how the guard knows
   * them: the first name and the photo the guard compares with.
   */
  private async whoIs(
    tx: TenantTxClient,
    e: ChildEscort,
    now: Date,
  ): Promise<{
    eligible: boolean;
    firstName: string | null;
    photoFileId: string | null;
  }> {
    if (e.kind === 'adult') {
      const account = await tx.account.findUnique({
        where: { id: e.accountId! },
        select: { status: true, fullName: true, photoFileId: true },
      });
      const lives = (await this.community.residents(tx, e.unitId)).some(
        (r) => r.accountId === e.accountId,
      );
      return {
        eligible: account?.status === 'active' && lives,
        firstName: firstNameOf(account?.fullName ?? null),
        photoFileId: account?.photoFileId ?? null,
      };
    }
    if (e.kind === 'worker') {
      const engagement = await this.community.engagementById(
        tx,
        e.engagementId!,
      );
      return {
        eligible:
          engagement !== null &&
          engagement.unitId === e.unitId &&
          engagementWorks(engagement, now),
        firstName: firstNameOf(engagement?.workerName ?? null),
        photoFileId: engagement?.photoFileId ?? null,
      };
    }
    return {
      eligible: e.revokedAt === null,
      firstName: firstNameOf(e.fullName),
      photoFileId: e.photoFileId,
    };
  }

  /**
   * Who is told, in the exit's transaction: a refusal is an alert to the
   * household adults and the roster's keepers; a child held for leaving
   * alone, to the household adults; an authorized exit to them, when the
   * household asks to know. Never the guard who recorded it.
   */
  /**
   * The household adults and the roster's keepers, their account rows
   * taken FOR KEY SHARE in id order (the lock a notification's row would
   * take): before the control's lock, never after it.
   */
  private async lockRecipients(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<{ adults: string[]; keepers: string[] }> {
    const adults = (await this.community.residents(tx, unitId)).map(
      (r) => r.accountId,
    );
    const keepers = await this.safety.holding(tx, 'guard_roster.manage');
    const ids = [...new Set([...adults, ...keepers])].sort();
    if (ids.length)
      await tx.$queryRaw`
        SELECT id FROM accounts WHERE id = ANY(${ids}::uuid[])
         ORDER BY id FOR KEY SHARE`;
    return { adults, keepers };
  }

  private async tell(
    tx: TenantTxClient,
    control: ChildControl,
    pickup: {
      id: string;
      outcome: ChildPickupOutcome;
      refusalReason: string | null;
    },
    to: { adults: string[]; keepers: string[] },
  ): Promise<void> {
    const guard = this.ctx.accountId;
    const { outcome, id: pickupId } = pickup;
    if (outcome === 'refused' || outcome === 'left_unverified')
      // A refusal under a lockdown, or offline by the rule (ADR 0057), is
      // the gate doing what it must: the household is told, not the
      // keepers. A release the server could not verify alerts both.
      await this.safety.notify(
        tx,
        pickup.refusalReason === 'lockdown' ||
          pickup.refusalReason === 'offline_unverified'
          ? to.adults
          : [...to.adults, ...to.keepers],
        'child.unauthorized_pickup',
        pickupId,
        {},
        guard,
      );
    else if (outcome === 'alone_refused')
      await this.safety.notify(
        tx,
        to.adults,
        'child.exit_alone',
        pickupId,
        {},
        guard,
      );
    else if (control.notifyPickups)
      await this.safety.notify(
        tx,
        to.adults,
        'child.picked_up',
        pickupId,
        { outcome },
        guard,
      );
  }

  private async exitView(
    tx: TenantTxClient,
    pickup: {
      id: string;
      outcome: ChildPickupOutcome;
      refusalReason: string | null;
      escortId: string | null;
      escortKind: ChildEscort['kind'] | null;
    },
  ): Promise<ChildExitView> {
    let firstName: string | null = null;
    if (pickup.escortId) {
      const escort = await tx.childEscort.findUnique({
        where: { id: pickup.escortId },
      });
      if (escort)
        firstName = (await this.whoIs(tx, escort, await dbNow(tx))).firstName;
    }
    return {
      pickupId: pickup.id,
      result:
        pickup.outcome === 'picked_up' || pickup.outcome === 'left_alone'
          ? 'authorized'
          : 'refused',
      outcome: pickup.outcome,
      reason: pickup.refusalReason,
      escort: pickup.escortKind ? { kind: pickup.escortKind, firstName } : null,
    };
  }
}

/** An escort's days, hours and post, as the rules read them. */
export function validityOf(e: ChildEscort): EscortValidity {
  return {
    validFrom: ofDate(e.validFrom),
    validUntil: e.validUntil ? ofDate(e.validUntil) : null,
    schedule: (e.schedule as WeeklySchedule | null) ?? null,
    gateId: e.gateId,
    placeId: e.placeId,
  };
}

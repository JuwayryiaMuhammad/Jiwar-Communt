import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type ChildControl,
  type ChildEscort,
  type ChildEscortKind,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import {
  AccountLifecycle,
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher, normalizePhone } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  checkWeeklySchedule,
  type WeeklySchedule,
} from '../../core/common/slots/weekly-schedule';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { DutyNamesReader } from '../roster/duty-names';
import { isCalendarDay, RosterCore } from '../roster/roster-core';
import { PostView } from '../roster/views/roster.views';
import {
  ChildCore,
  controlNotFound,
  MAX_ESCORTS,
  type ChildEscortEnd,
} from './child-core';
import { pickupPayload } from './child-tokens';
import {
  ChildEscortSecretView,
  ChildEscortView,
  PickupCodeView,
} from './views/escort.views';

/** The idempotency resource of a response carrying a pickup code. */
export const CHILD_PICKUP_RESOURCE = 'child_pickup';

export const escortNotFound = () =>
  appError.notFound(ErrorCode.CHILD_ESCORT_NOT_FOUND, 'Escort not found');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid escort', {
    fields,
  });

/** What the household may send for an escort's validity. */
export interface EscortValidityInput {
  validFrom?: string;
  validUntil?: string | null;
  schedule?: WeeklySchedule | null;
  post?: { gateId?: string; zoneId?: string } | null;
}

export interface AddEscortInput extends EscortValidityInput {
  kind: ChildEscortKind;
  accountId?: string;
  engagementId?: string;
  outside?: { fullName: string; phone: string; photoFileId?: string };
}

/** `YYYY-MM-DD` ↔ the `@db.Date` column. */
const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const ofDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Who may collect a child (ADR 0054), the household's side: an adult of
 * the household (an account that lives in the unit), one of the unit's
 * domestic workers (an active engagement), or an outside person with a
 * name, a phone, an optional photo and a personal pickup code. Each is
 * valid from a day, until a day or open-ended, on weekly hours or at any
 * time, at a post or anywhere. Managed by the primary or a `household`
 * delegate under the unit's row and the control's lock; at most ten live
 * per child. Revoked once, never deleted.
 *
 * An outside person's code is a QR `JWP1.<token>`, a 6-digit code derived
 * from the token, and a link `<PUBLIC_APP_URL>/c#<token>`, answered once at
 * creation and at a reissue (Idempotency-Key claimed, no body stored).
 * Only HMACs are kept, and the global pointer of the link.
 *
 * An adult's escorts end when the account stops living in the unit, is
 * deactivated or erased (in that transaction, account lock first, then the
 * control). A worker's engagement that ends leaves the escort inert: the
 * gate checks the engagement at every scan.
 */
@Injectable()
export class ChildEscortsService implements OnModuleInit {
  private readonly logger = new Logger(ChildEscortsService.name);
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly core: ChildCore,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly globalDb: GlobalDbService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
    private readonly tokens: AccessTokens,
    private readonly hasher: IdentifierHasher,
    private readonly roster: RosterCore,
    private readonly names: DutyNamesReader,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  onModuleInit(): void {
    this.idempotency.renderer(CHILD_PICKUP_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.reissueIn(tx, id, true)),
    );
    // An adult who no longer lives in the unit (or no longer has an account
    // that works) can no longer collect its children. Core holds the
    // account first; the controls come after it, as everywhere.
    const leaving = (tx: TenantTxClient, account: { id: string }) =>
      this.endAdult(tx, account.id, false);
    this.lifecycle.onResidenceChanged((tx, account) =>
      this.endAdult(tx, account.id, true).then(() => undefined),
    );
    this.lifecycle.onDeactivated(async (tx, account) => {
      await leaving(tx, account);
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await leaving(tx, account);
      return [];
    });
  }

  /** A child's live escorts, for the household adults. */
  list(unitId: string, memberId: string): Promise<ChildEscortView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.requireReader(tx, unitId);
      const control = await this.liveControl(tx, unitId, memberId);
      const escorts = await tx.childEscort.findMany({
        where: { controlId: control.id, revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return this.views(tx, escorts);
    });
  }

  /** Adds one, with the outside person's pickup code once. */
  add(
    unitId: string,
    memberId: string,
    input: AddEscortInput,
  ): Promise<ChildEscortSecretView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { onBehalfOf } = await this.core.manage(tx, unitId);
      // First: a replay answers the escort it made.
      const id = newId();
      await this.idempotency.claim(tx, { type: CHILD_PICKUP_RESOURCE, id });
      const control = await this.lockLive(tx, unitId, memberId);
      await this.community.assertHouseholdMutable(tx, unitId);
      const subject = await this.subject(tx, unitId, input);
      const validity = await this.validity(tx, input, null);
      const live = await tx.childEscort.findMany({
        where: { controlId: control.id, revokedAt: null },
        select: { accountId: true, engagementId: true },
      });
      if (
        (subject.accountId &&
          live.some((e) => e.accountId === subject.accountId)) ||
        (subject.engagementId &&
          live.some((e) => e.engagementId === subject.engagementId))
      )
        throw appError.conflict(
          ErrorCode.CHILD_ESCORT_DUPLICATE,
          'Already an escort of this child',
        );
      if (live.length >= MAX_ESCORTS)
        throw appError.conflict(
          ErrorCode.CHILD_ESCORT_LIMIT_REACHED,
          'This child has as many escorts as allowed',
          { params: { max: MAX_ESCORTS } },
        );
      let photoFileId: string | null = null;
      if (input.kind === 'outside' && input.outside?.photoFileId) {
        const file = await this.files.claim(
          tx,
          input.outside.photoFileId,
          'child_escort_photo',
        );
        if (!file)
          throw invalid([
            {
              field: 'outside.photoFileId',
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
        photoFileId = file.id;
      }
      const now = await dbNow(tx);
      const secret = input.kind === 'outside' ? await this.newPickup(tx) : null;
      const escort = await tx.childEscort.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          controlId: control.id,
          unitId,
          kind: input.kind,
          accountId: subject.accountId,
          engagementId: subject.engagementId,
          fullName: subject.fullName,
          phone: subject.phone,
          photoFileId,
          pickupCodeHash: secret?.codeHash ?? null,
          pickupQrHash: secret?.qrHash ?? null,
          pickupIssuedAt: secret ? now : null,
          ...validity,
          createdById: this.ctx.accountId,
        },
      });
      if (secret) await this.link(tx, escort.id, secret.linkHash);
      await this.audit.record(tx, {
        action: 'child_escort.added',
        targetId: id,
        changes: diffChanges(null, audited(escort), 'child_escort.added'),
        metadata: {
          controlId: control.id,
          unitId,
          memberId,
          ...(onBehalfOf ? { onBehalfOf } : {}),
        },
      });
      const [view] = await this.views(tx, [escort]);
      return { ...view, pickup: secret ? this.pickupOf(secret.token) : null };
    });
  }

  /** Its validity: days, hours, post. Waits under a death review. */
  update(
    unitId: string,
    memberId: string,
    escortId: string,
    input: EscortValidityInput,
  ): Promise<ChildEscortView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { onBehalfOf } = await this.core.manage(tx, unitId);
      const control = await this.lockLive(tx, unitId, memberId);
      const before = await this.lockEscort(tx, control, escortId);
      await this.community.assertHouseholdMutable(tx, unitId);
      const validity = await this.validity(tx, input, before);
      const escort = await tx.childEscort.update({
        where: { id: before.id },
        data: validity,
      });
      const changes = diffChanges(
        audited(before),
        audited(escort),
        'child_escort.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'child_escort.updated',
          targetId: escort.id,
          changes,
          metadata: onBehalfOf ? { onBehalfOf } : undefined,
        });
      const [view] = await this.views(tx, [escort]);
      return view;
    });
  }

  /** Revoked at once and always (it never waits for a review): 204. */
  async revoke(
    unitId: string,
    memberId: string,
    escortId: string,
  ): Promise<void> {
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.core.manage(tx, unitId);
      const control = await this.lockLive(tx, unitId, memberId);
      const escort = await this.lockEscort(tx, control, escortId);
      await this.core.revoke(
        tx,
        escort,
        'household',
        this.ctx.accountId,
        after,
      );
    });
    await runAfterCommit(after, this.logger);
  }

  /** A new pickup code for an outside person: the old one dies at once. */
  reissue(
    unitId: string,
    memberId: string,
    escortId: string,
  ): Promise<ChildEscortSecretView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.manage(tx, unitId);
      const control = await this.lockLive(tx, unitId, memberId);
      const escort = await this.lockEscort(tx, control, escortId);
      if (escort.kind !== 'outside') throw escortNotFound();
      await this.idempotency.claim(tx, {
        type: CHILD_PICKUP_RESOURCE,
        id: escort.id,
      });
      return this.reissueIn(tx, escort.id, false);
    });
  }

  // --------------------------------------------------------------------------

  /**
   * Revokes the live adult escorts of an account (`left_household`): every
   * one when the account is deactivated or erased (`all`), and on a change
   * of residence those of the units where it no longer lives.
   */
  private async endAdult(
    tx: TenantTxClient,
    accountId: string,
    onlyWhereGone: boolean,
  ): Promise<void> {
    const escorts = await tx.childEscort.findMany({
      where: { accountId, revokedAt: null },
      select: { id: true, controlId: true, unitId: true },
      orderBy: { controlId: 'asc' },
    });
    if (!escorts.length) return;
    const living = onlyWhereGone
      ? new Set(await this.community.unitsWhere(tx, accountId, 'gateEntry'))
      : new Set<string>();
    for (const e of escorts) {
      if (living.has(e.unitId)) continue;
      // The control first, as every writer of its escorts takes it.
      const control = await this.core.lock(tx, e.controlId);
      if (!control) continue;
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM child_escorts
         WHERE id = ${e.id}::uuid AND revoked_at IS NULL FOR UPDATE`;
      if (!row) continue;
      await this.core.revoke(
        tx,
        await tx.childEscort.findUniqueOrThrow({ where: { id: e.id } }),
        'left_household' satisfies ChildEscortEnd,
        null,
      );
    }
  }

  /** The child's live control, FOR UPDATE, or 404. */
  private async lockLive(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<ChildControl> {
    await this.core.requireMinor(tx, unitId, memberId);
    const control = await this.core.lockLive(tx, unitId, memberId);
    if (!control) throw controlNotFound();
    return control;
  }

  /** The child's live control, read (for the readers), or 404. */
  private async liveControl(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<ChildControl> {
    await this.core.requireMinor(tx, unitId, memberId);
    const control = await tx.childControl.findFirst({
      where: { unitId, memberId, endedAt: null },
    });
    if (!control) throw controlNotFound();
    return control;
  }

  /** A live escort of this control, FOR UPDATE, or 404. */
  private async lockEscort(
    tx: TenantTxClient,
    control: ChildControl,
    escortId: string,
  ): Promise<ChildEscort> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_escorts
       WHERE id = ${escortId}::uuid AND control_id = ${control.id}::uuid
         AND revoked_at IS NULL
         FOR UPDATE`;
    if (!row) throw escortNotFound();
    return tx.childEscort.findUniqueOrThrow({ where: { id: escortId } });
  }

  /** Who the escort is, by kind, checked as of now. */
  private async subject(
    tx: TenantTxClient,
    unitId: string,
    input: AddEscortInput,
  ): Promise<{
    accountId: string | null;
    engagementId: string | null;
    fullName: string | null;
    phone: string | null;
  }> {
    const none = {
      accountId: null,
      engagementId: null,
      fullName: null,
      phone: null,
    };
    const fields: FieldError[] = [];
    const want = {
      accountId: input.kind === 'adult',
      engagementId: input.kind === 'worker',
      outside: input.kind === 'outside',
    };
    for (const [field, wanted] of Object.entries(want)) {
      const given = input[field as keyof typeof want] !== undefined;
      if (wanted && !given)
        fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
      if (!wanted && given)
        fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    }
    if (fields.length) throw invalid(fields);
    if (input.kind === 'adult') {
      const residents = await this.community.residents(tx, unitId);
      if (!residents.some((r) => r.accountId === input.accountId))
        throw invalid([
          { field: 'accountId', code: FieldErrorCode.ESCORT_NOT_ELIGIBLE },
        ]);
      return { ...none, accountId: input.accountId! };
    }
    if (input.kind === 'worker') {
      const e = await this.community.engagementById(tx, input.engagementId!);
      if (!e || e.unitId !== unitId || !engagementWorks(e, await dbNow(tx)))
        throw invalid([
          { field: 'engagementId', code: FieldErrorCode.ESCORT_NOT_ELIGIBLE },
        ]);
      return { ...none, engagementId: e.engagementId };
    }
    const phone = normalizePhone(input.outside!.phone);
    if (!phone)
      throw invalid([
        { field: 'outside.phone', code: FieldErrorCode.INVALID_PHONE },
      ]);
    return { ...none, fullName: input.outside!.fullName.trim(), phone };
  }

  /** The validity as stored, from the input over `before` (if any). */
  private async validity(
    tx: TenantTxClient,
    input: EscortValidityInput,
    before: ChildEscort | null,
  ) {
    const fields: FieldError[] = [];
    for (const field of ['validFrom', 'validUntil'] as const) {
      const day = input[field];
      if (typeof day === 'string' && !isCalendarDay(day))
        fields.push({ field, code: FieldErrorCode.INVALID_VALUE });
    }
    if (fields.length) throw invalid(fields);
    const today = ofDate(await this.core.today(tx));
    const validFrom =
      input.validFrom ?? (before ? ofDate(before.validFrom) : today);
    if (input.validFrom !== undefined && input.validFrom < today)
      fields.push({
        field: 'validFrom',
        code: FieldErrorCode.DAY_OUT_OF_RANGE,
        params: { min: today },
      });
    const validUntil =
      input.validUntil === undefined
        ? before?.validUntil
          ? ofDate(before.validUntil)
          : null
        : input.validUntil;
    if (validUntil !== null && validUntil < validFrom)
      fields.push({
        field: 'validUntil',
        code: FieldErrorCode.ENDS_BEFORE_START,
      });
    let schedule: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
    if (input.schedule === null) schedule = Prisma.DbNull;
    else if (input.schedule !== undefined)
      schedule = checkWeeklySchedule(
        input.schedule,
        fields,
      ) as unknown as Prisma.InputJsonValue;
    if (fields.length) throw invalid(fields);
    let post: { gateId: string | null; placeId: string | null } | undefined;
    if (input.post === null) post = { gateId: null, placeId: null };
    else if (input.post !== undefined)
      post = await this.roster.requirePost(tx, input.post);
    return {
      validFrom: toDate(validFrom),
      validUntil: validUntil === null ? null : toDate(validUntil),
      ...(schedule === undefined ? {} : { schedule }),
      ...(post ?? {}),
    };
  }

  /**
   * A token whose derived 6-digit code is free among the compound's live
   * pickup codes; its HMACs and the link's.
   */
  private async newPickup(tx: TenantTxClient) {
    const tenantId = this.ctx.txTenantId;
    const issued = await this.tokens.issue(tenantId, 6, async (code) => {
      const taken = await tx.childEscort.count({
        where: {
          pickupCodeHash: this.hasher.hashChildPickupCode(tenantId, code),
        },
      });
      return taken > 0;
    });
    return {
      token: issued.token,
      codeHash: this.hasher.hashChildPickupCode(tenantId, issued.code),
      qrHash: this.hasher.hashChildPickupQr(tenantId, issued.token),
      linkHash: this.hasher.hashChildPickupLink(issued.token),
    };
  }

  private link(tx: TenantTxClient, escortId: string, linkHash: string) {
    return this.globalDb.in(tx).childPickupLink.create({
      data: { tokenHash: linkHash, tenantId: this.ctx.txTenantId, escortId },
    });
  }

  private pickupOf(token: string): PickupCodeView {
    return {
      code: this.tokens.codeOf(token, 6),
      qrPayload: pickupPayload(token),
      link: `${this.appUrl}/c#${token}`,
    };
  }

  /**
   * Under the escort's lock: a live outside escort the caller may manage,
   * a new code. A replay of a request whose escort is gone since answers it
   * as it is, with no code.
   */
  private async reissueIn(
    tx: TenantTxClient,
    id: string,
    replay: boolean,
  ): Promise<ChildEscortSecretView> {
    const found = await tx.childEscort.findUnique({ where: { id } });
    if (!found) throw escortNotFound();
    await this.core.manage(tx, found.unitId);
    const control = await this.core.lock(tx, found.controlId);
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_escorts WHERE id = ${id}::uuid FOR UPDATE`;
    const escort = await tx.childEscort.findUniqueOrThrow({
      where: { id: row.id },
    });
    if (!control || escort.revokedAt || escort.kind !== 'outside') {
      if (!replay) throw escortNotFound();
      const [view] = await this.views(tx, [escort]);
      return { ...view, pickup: null };
    }
    const secret = await this.newPickup(tx);
    const now = await dbNow(tx);
    const updated = await tx.childEscort.update({
      where: { id },
      data: {
        pickupCodeHash: secret.codeHash,
        pickupQrHash: secret.qrHash,
        // Later than the last one, whatever the clock's resolution.
        pickupIssuedAt:
          escort.pickupIssuedAt && now <= escort.pickupIssuedAt
            ? new Date(escort.pickupIssuedAt.getTime() + 1)
            : now,
      },
    });
    await this.globalDb
      .in(tx)
      .childPickupLink.deleteMany({ where: { escortId: id } });
    await this.link(tx, id, secret.linkHash);
    await this.audit.record(tx, {
      action: 'child_escort.code_reissued',
      targetId: id,
    });
    const [view] = await this.views(tx, [updated]);
    return { ...view, pickup: this.pickupOf(secret.token) };
  }

  /** The household's view: names as it knows them, an outside photo. */
  async views(
    tx: TenantTxClient,
    escorts: readonly ChildEscort[],
  ): Promise<ChildEscortView[]> {
    const names = await this.names.read(
      tx,
      escorts.map((e) => e.accountId),
      escorts,
    );
    const out: ChildEscortView[] = [];
    for (const e of escorts) {
      let name: string | null = e.fullName;
      if (e.accountId) name = names.people.get(e.accountId)?.fullName ?? null;
      if (e.engagementId)
        name =
          (await this.community.engagementById(tx, e.engagementId))
            ?.workerName ?? null;
      const photo = await this.files.readUrl(tx, e.photoFileId);
      out.push({
        id: e.id,
        kind: e.kind,
        accountId: e.accountId,
        engagementId: e.engagementId,
        name,
        phone: e.phone,
        photoUrl: photo?.url ?? null,
        validFrom: ofDate(e.validFrom),
        validUntil: e.validUntil ? ofDate(e.validUntil) : null,
        schedule: (e.schedule as WeeklySchedule | null) ?? null,
        post: e.gateId || e.placeId ? PostView.of(e, names) : null,
        pickupIssuedAt: e.pickupIssuedAt,
        createdAt: e.createdAt,
      });
    }
    return out;
  }
}

/** An engagement that works now: active, not banned, not past its end. */
export function engagementWorks(
  e: { status: string; banned: boolean; validUntil: Date | null },
  now: Date,
): boolean {
  return (
    e.status === 'active' &&
    !e.banned &&
    (e.validUntil === null || e.validUntil > now)
  );
}

/** What the audit sees of an escort: who and when by value; a person as changed. */
function audited(e: ChildEscort) {
  return {
    kind: e.kind,
    accountId: e.accountId,
    engagementId: e.engagementId,
    fullName: e.fullName,
    phone: e.phone,
    photo: e.photoFileId,
    validFrom: ofDate(e.validFrom),
    validUntil: e.validUntil ? ofDate(e.validUntil) : null,
    schedule: e.schedule,
    gateId: e.gateId,
    placeId: e.placeId,
  };
}

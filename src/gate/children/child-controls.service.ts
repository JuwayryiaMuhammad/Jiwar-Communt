import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ChildControl } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import {
  AccountLifecycle,
  runAfterCommit,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  adultCutoff,
  ageOn,
  isAdult,
  localToday,
} from '../../core/common/egyptian-national-id';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { firstNameOf } from '../../core/common/http/personal';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { ChildCore, controlNotFound } from './child-core';
import { issueChildCard } from './child-tokens';
import {
  ChildControlSecretView,
  ChildControlView,
  ChildView,
} from './views/child.views';

/** The sweep that ends the control of a child who came of age (ADR 0054). */
export const CHILD_MAJORITY_SWEEP = 'gate.child_majority';
/** The idempotency resource of a response carrying a child's card. */
export const CHILD_CARD_RESOURCE = 'child_card';

/**
 * A child's exit control (ADR 0054), the household's side: the primary or a
 * `household` delegate turns it on for one of the unit's minors, sets its
 * two switches and the child's photo, reissues the card, and turns it off.
 * The household adults read it.
 *
 * The card's QR (`JWC1.<token>`) is answered once, at turn-on and at a
 * reissue; only its SHA-256 is kept. `Idempotency-Key` is claimed but no
 * body is stored (it holds the card): a replay reissues again, the rule of
 * a visitor's link (ADR 0030).
 *
 * The control ends with the child's place: when their membership ends or
 * the member row comes of age (`onMinorLeaving`, in that transaction), and
 * on the child's 18th birthday by the compound's day (the sweep, hourly;
 * until it runs the gate already treats the card as unknown).
 */
@Injectable()
export class ChildControlsService implements OnModuleInit {
  private readonly logger = new Logger(ChildControlsService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly core: ChildCore,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly globalDb: GlobalDbService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CHILD_CARD_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.reissueIn(tx, id, true)),
    );
    // A minor leaves the household or comes of age: the control ends with
    // it, in that transaction (the unit's row is held there already).
    this.lifecycle.onMinorLeaving(async (tx, minor) => {
      const control = await this.core.lockLive(
        tx,
        minor.unitId,
        minor.memberId,
      );
      if (control)
        await this.core.end(
          tx,
          control,
          minor.cause === 'came_of_age' ? 'came_of_age' : 'left_household',
          null,
        );
      return [];
    });
    this.sweep.register(CHILD_MAJORITY_SWEEP, (now) => this.majority(now));
  }

  /** The unit's minors and their controls, for the household adults. */
  list(unitId: string): Promise<ChildView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.requireReader(tx, unitId);
      const today = await this.core.today(tx);
      const minors = (await this.community.minors(tx, unitId)).filter(
        (m) => !isAdult(m.birthDate, today),
      );
      const controls = await tx.childControl.findMany({
        where: {
          unitId,
          endedAt: null,
          memberId: { in: minors.map((m) => m.memberId) },
        },
      });
      const byMember = new Map(controls.map((c) => [c.memberId, c]));
      const views: ChildView[] = [];
      for (const m of minors) {
        const control = byMember.get(m.memberId);
        views.push({
          memberId: m.memberId,
          firstName: firstNameOf(m.fullName) ?? '',
          fullName: m.fullName,
          age: ageOn(m.birthDate, today),
          control: control ? await this.view(tx, control) : null,
        });
      }
      return views;
    });
  }

  /**
   * Turns it on, with its card, once. Refused under a death review (ADR
   * 0021); one live control per child (409 CHILD_CONTROL_ACTIVE, backed by
   * a partial unique index), decided under the unit's row lock.
   */
  turnOn(
    unitId: string,
    memberId: string,
    input: { mayLeaveAlone: boolean; notifyPickups: boolean },
  ): Promise<ChildControlSecretView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { onBehalfOf } = await this.core.manage(tx, unitId);
      // First: a replay answers the control it made, live by now.
      const id = newId();
      await this.idempotency.claim(tx, { type: CHILD_CARD_RESOURCE, id });
      const minor = await this.core.requireMinor(tx, unitId, memberId);
      await this.community.assertHouseholdMutable(tx, unitId);
      if (await this.core.lockLive(tx, unitId, memberId))
        throw appError.conflict(
          ErrorCode.CHILD_CONTROL_ACTIVE,
          "The child's exit control is on already",
        );
      const card = issueChildCard(this.ctx.txTenantId);
      const now = await dbNow(tx);
      const control = await tx.childControl.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          unitId,
          memberId,
          mayLeaveAlone: input.mayLeaveAlone,
          notifyPickups: input.notifyPickups,
          cardTokenHash: card.tokenHash,
          cardIssuedAt: now,
          turnedOnById: this.ctx.accountId,
          turnedOnAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'child_control.turned_on',
        targetId: id,
        metadata: {
          unitId,
          memberId,
          mayLeaveAlone: input.mayLeaveAlone,
          notifyPickups: input.notifyPickups,
          ...(onBehalfOf ? { onBehalfOf } : {}),
        },
      });
      return this.secretView(tx, control, minor.fullName, card.qrPayload);
    });
  }

  /**
   * The two switches. Letting a child leave alone loosens the control, so
   * it waits for the management under a death review, like turning it on;
   * anything that tightens it never waits.
   */
  update(
    unitId: string,
    memberId: string,
    input: { mayLeaveAlone?: boolean; notifyPickups?: boolean },
  ): Promise<ChildControlView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { onBehalfOf } = await this.core.manage(tx, unitId);
      const before = await this.requireLive(tx, unitId, memberId);
      if (input.mayLeaveAlone && !before.mayLeaveAlone)
        await this.community.assertHouseholdMutable(tx, unitId);
      const control = await tx.childControl.update({
        where: { id: before.id },
        data: {
          mayLeaveAlone: input.mayLeaveAlone,
          notifyPickups: input.notifyPickups,
        },
      });
      const changes = diffChanges(
        switches(before),
        switches(control),
        'child_control.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'child_control.updated',
          targetId: control.id,
          changes,
          metadata: onBehalfOf ? { onBehalfOf } : undefined,
        });
      return this.view(tx, control);
    });
  }

  /** Off, at once and always (it never waits for a review): 204. */
  async turnOff(unitId: string, memberId: string): Promise<void> {
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.core.manage(tx, unitId);
      const control = await this.requireLive(tx, unitId, memberId);
      await this.core.end(tx, control, 'household', this.ctx.accountId, after);
    });
    await runAfterCommit(after, this.logger);
  }

  /** A new card: the old one stops scanning in this transaction. */
  reissueCard(
    unitId: string,
    memberId: string,
  ): Promise<ChildControlSecretView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.manage(tx, unitId);
      const control = await this.requireLive(tx, unitId, memberId);
      await this.idempotency.claim(tx, {
        type: CHILD_CARD_RESOURCE,
        id: control.id,
      });
      return this.reissueIn(tx, control.id, false);
    });
  }

  /** The child's photo: the caller's finalized `child_photo`; 204. */
  async setPhoto(
    unitId: string,
    memberId: string,
    fileId: string,
  ): Promise<void> {
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.core.manage(tx, unitId);
      const control = await this.requireLive(tx, unitId, memberId);
      const file = await this.files.claim(tx, fileId, 'child_photo');
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Not one of your finalized child photos',
          {
            fields: [
              { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
            ],
          },
        );
      await this.files.attach(tx, file);
      await tx.childControl.update({
        where: { id: control.id },
        data: { photoFileId: file.id },
      });
      if (control.photoFileId) {
        const old = control.photoFileId;
        await this.files.markDeleted(
          tx,
          { id: old, purpose: 'child_photo' },
          'replaced',
        );
        after.push(() => this.files.purge(old).then(() => undefined));
      }
      await this.photoChanged(tx, control, file.id);
    });
    await runAfterCommit(after, this.logger);
  }

  /** Nothing to remove is not an error: a retried delete is safe; 204. */
  async removePhoto(unitId: string, memberId: string): Promise<void> {
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.core.manage(tx, unitId);
      const control = await this.requireLive(tx, unitId, memberId);
      if (!control.photoFileId) return;
      const old = control.photoFileId;
      await tx.childControl.update({
        where: { id: control.id },
        data: { photoFileId: null },
      });
      await this.files.markDeleted(
        tx,
        { id: old, purpose: 'child_photo' },
        'owner',
      );
      after.push(() => this.files.purge(old).then(() => undefined));
      await this.photoChanged(tx, control, null);
    });
    await runAfterCommit(after, this.logger);
  }

  /**
   * Every live control of a child who turned 18 by the compound's day ends
   * (`came_of_age`): its card dies and its photo goes. One control per
   * transaction, taken FOR UPDATE SKIP LOCKED and judged again under the
   * lock, so a turn-off or a removal holding it wins.
   */
  majority(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const { timezone } = await tx.tenantSettings.findUniqueOrThrow({
          where: { tenantId },
          select: { timezone: true },
        });
        const cutoff = adultCutoff(localToday(timezone, now));
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT c.id FROM child_controls c
            JOIN household_members m ON m.id = c.member_id
           WHERE c.ended_at IS NULL AND m.birth_date <= ${cutoff}::date
           ORDER BY c.id
           LIMIT 200`;
        return rows.map((r) => ({ id: r.id, cutoff }));
      },
      async (tx, _tenantId, item) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT c.id FROM child_controls c
           WHERE c.id = ${item.id}::uuid AND c.ended_at IS NULL
             FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return 0;
        const control = await tx.childControl.findUniqueOrThrow({
          where: { id: item.id },
        });
        const member = await tx.householdMember.findUniqueOrThrow({
          where: { id: control.memberId },
          select: { birthDate: true },
        });
        if (member.birthDate > item.cutoff) return 0;
        await this.core.end(tx, control, 'came_of_age', null);
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------

  private async requireLive(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<ChildControl> {
    await this.core.requireMinor(tx, unitId, memberId);
    const control = await this.core.lockLive(tx, unitId, memberId);
    if (!control) throw controlNotFound();
    return control;
  }

  /**
   * Under the control's lock: a live control the caller may manage, a new
   * card. A replay of a request whose control has ended since answers the
   * control as it is, with no card.
   */
  private async reissueIn(
    tx: TenantTxClient,
    id: string,
    replay: boolean,
  ): Promise<ChildControlSecretView> {
    const found = await tx.childControl.findUnique({ where: { id } });
    if (!found) throw controlNotFound();
    await this.core.manage(tx, found.unitId);
    const control = await this.core.lock(tx, id);
    if (!control) throw controlNotFound();
    const member = await this.community.minorsById(tx, [control.memberId]);
    const fullName = member.get(control.memberId)?.fullName ?? '';
    if (control.endedAt) {
      if (!replay) throw controlNotFound();
      return { ...(await this.endedView(control)), card: null };
    }
    const card = issueChildCard(this.ctx.txTenantId);
    const now = await dbNow(tx);
    const updated = await tx.childControl.update({
      where: { id },
      data: {
        cardTokenHash: card.tokenHash,
        // Later than the last one, whatever the clock's resolution.
        cardIssuedAt:
          control.cardIssuedAt && now <= control.cardIssuedAt
            ? new Date(control.cardIssuedAt.getTime() + 1)
            : now,
      },
    });
    await this.audit.record(tx, {
      action: 'child_control.card_reissued',
      targetId: id,
    });
    return this.secretView(tx, updated, fullName, card.qrPayload);
  }

  private async view(
    tx: TenantTxClient,
    control: ChildControl,
  ): Promise<ChildControlView> {
    const photo = await this.files.readUrl(tx, control.photoFileId);
    return ChildControlView.of(control, photo?.url ?? null);
  }

  /** An ended control on a replay: no card and no photo left. */
  private endedView(control: ChildControl): Promise<ChildControlView> {
    return Promise.resolve({
      id: control.id,
      mayLeaveAlone: control.mayLeaveAlone,
      notifyPickups: control.notifyPickups,
      cardIssuedAt: control.updatedAt,
      photoUrl: null,
      turnedOnAt: control.turnedOnAt,
    });
  }

  private async secretView(
    tx: TenantTxClient,
    control: ChildControl,
    fullName: string,
    qrPayload: string,
  ): Promise<ChildControlSecretView> {
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: this.ctx.txTenantId },
      select: { name: true },
    });
    return {
      ...(await this.view(tx, control)),
      card: {
        qrPayload,
        firstName: firstNameOf(fullName) ?? '',
        unitCode: await this.community.unitCode(tx, control.unitId),
        compoundName: tenant.name,
      },
    };
  }

  private photoChanged(
    tx: TenantTxClient,
    control: ChildControl,
    to: string | null,
  ) {
    return this.audit.record(tx, {
      action: 'child_control.photo_changed',
      targetId: control.id,
      changes: diffChanges(
        { photo: control.photoFileId },
        { photo: to },
        'child_control.photo_changed',
      ),
    });
  }
}

function switches(c: ChildControl) {
  return { mayLeaveAlone: c.mayLeaveAlone, notifyPickups: c.notifyPickups };
}

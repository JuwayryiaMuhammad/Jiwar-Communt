import { Injectable } from '@nestjs/common';
import type { ChildControl, ChildEscort } from '@prisma/client';
import { CommunityGatePort, type UnitMinor } from '../../community';
import type { AfterCommit } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { localToday, isAdult } from '../../core/common/egyptian-national-id';
import { appError, ErrorCode } from '../../core/common/errors';
import { GlobalDbService } from '../../core/database/global-db.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';

/** Why a control ended (`child_controls_end_reason`). */
export type ChildControlEnd = 'household' | 'left_household' | 'came_of_age';

/** Why an escort was revoked (`child_escorts_revoke_reason`). */
export type ChildEscortEnd = 'household' | 'left_household' | 'control_off';

/** A child has this many live escorts at most. */
export const MAX_ESCORTS = 10;

export const childNotFound = () =>
  appError.notFound(ErrorCode.CHILD_NOT_FOUND, 'Child not found');
export const controlNotFound = () =>
  appError.notFound(
    ErrorCode.CHILD_CONTROL_NOT_FOUND,
    "The child's exit control is not on",
  );

/**
 * What the children's services share (ADR 0054): who may read and who may
 * manage a unit's children, the compound's day, a control's lock, and the
 * one way a control ends.
 *
 * **Lock order of the household's writes:** the unit's row (`lockUnits`,
 * FOR NO KEY UPDATE), the household's authority, the member (FOR SHARE),
 * the control (FOR UPDATE), its escorts (FOR UPDATE, by id). The hooks that
 * end a control (a minor leaving, a coming of age, an escort's account
 * deactivated or erased) hold the account or the unit first and take the
 * control after it. The gate's exit never takes a unit's row or an account
 * after the control, so no path waits in a cycle.
 */
@Injectable()
export class ChildCore {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly globalDb: GlobalDbService,
  ) {}

  /** Today in the compound's time zone, by the database's clock. */
  async today(tx: TenantTxClient): Promise<Date> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    return localToday(timezone, await dbNow(tx));
  }

  async timeZone(tx: TenantTxClient): Promise<string> {
    return (await this.settings.inTx(tx, this.ctx.txTenantId)).timezone;
  }

  /**
   * The household adults read a unit's children: the people who live there
   * with an account (`gateEntry`, ADR 0031: residing occupants and adult
   * members), never a landlord, a minor or the management. A unit the
   * caller has no place in is not found.
   */
  async requireReader(tx: TenantTxClient, unitId: string): Promise<void> {
    const place = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!place)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    if (!place.gateEntry)
      throw appError.forbidden(
        ErrorCode.NOT_A_RESIDENT,
        "A unit's children are for the people who live in it",
      );
  }

  /**
   * The unit's row first, then the primary or a `household` delegate (ADR
   * 0016). Returns the primary a delegate acts for.
   */
  async manage(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<{ onBehalfOf: string | null }> {
    await this.community.lockUnit(tx, unitId);
    const { onBehalfOf } = await this.community.requireHousehold(tx, unitId);
    return { onBehalfOf };
  }

  /** One of the unit's minors, under 18 on the compound's day, FOR SHARE. */
  async requireMinor(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<UnitMinor> {
    const minor = await this.community.minorOf(tx, unitId, memberId);
    if (!minor || isAdult(minor.birthDate, await this.today(tx)))
      throw childNotFound();
    return minor;
  }

  /** The child's live control, FOR UPDATE, or null. */
  async lockLive(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<ChildControl | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_controls
       WHERE member_id = ${memberId}::uuid AND unit_id = ${unitId}::uuid
         AND ended_at IS NULL
         FOR UPDATE`;
    return rows.length
      ? tx.childControl.findUniqueOrThrow({ where: { id: rows[0].id } })
      : null;
  }

  /** A control by id, FOR UPDATE; null when there is none. */
  async lock(tx: TenantTxClient, id: string): Promise<ChildControl | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_controls WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length
      ? tx.childControl.findUniqueOrThrow({ where: { id } })
      : null;
  }

  /**
   * Ends a live control held FOR UPDATE, in the caller's transaction: the
   * card dies, the photo is deleted, and every live escort is revoked
   * (`control_off`). `by` is the account when the household ended it, null
   * for the system. A request passes `after` to purge the photo's object
   * once it commits; the hooks and sweeps leave it to the files sweep.
   */
  async end(
    tx: TenantTxClient,
    control: ChildControl,
    reason: ChildControlEnd,
    by: string | null,
    after?: AfterCommit[],
  ): Promise<void> {
    if (control.endedAt) return;
    const escortsRevoked = await this.revokeAll(tx, control.id, 'control_off');
    await tx.childControl.update({
      where: { id: control.id },
      data: {
        endedAt: await dbNow(tx),
        endReason: reason,
        endedById: by,
        cardTokenHash: null,
        cardIssuedAt: null,
        photoFileId: null,
      },
    });
    if (control.photoFileId) {
      const photo = control.photoFileId;
      await this.files.markDeleted(
        tx,
        { id: photo, purpose: 'child_photo' },
        'retention',
      );
      after?.push(() => this.files.purge(photo).then(() => undefined));
    }
    await this.audit.record(tx, {
      action: 'child_control.ended',
      targetId: control.id,
      metadata: {
        unitId: control.unitId,
        memberId: control.memberId,
        reasonCode: reason,
        escortsRevoked,
      },
    });
  }

  /** Every live escort of a control held FOR UPDATE; how many. */
  async revokeAll(
    tx: TenantTxClient,
    controlId: string,
    reason: ChildEscortEnd,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM child_escorts
       WHERE control_id = ${controlId}::uuid AND revoked_at IS NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of rows)
      await this.revoke(
        tx,
        await tx.childEscort.findUniqueOrThrow({ where: { id } }),
        reason,
        null,
      );
    return rows.length;
  }

  /**
   * Revokes a live escort held FOR UPDATE (under its control's lock): its
   * pickup code, QR and link die, and an outside escort's photo is deleted.
   * Their name and phone stay 30 days, for the household's records.
   */
  async revoke(
    tx: TenantTxClient,
    escort: ChildEscort,
    reason: ChildEscortEnd,
    by: string | null,
    after?: AfterCommit[],
  ): Promise<void> {
    if (escort.revokedAt) return;
    await tx.childEscort.update({
      where: { id: escort.id },
      data: {
        revokedAt: await dbNow(tx),
        revokeReason: reason,
        revokedById: by,
        pickupCodeHash: null,
        pickupQrHash: null,
        pickupIssuedAt: null,
        photoFileId: null,
      },
    });
    await this.globalDb
      .in(tx)
      .childPickupLink.deleteMany({ where: { escortId: escort.id } });
    if (escort.photoFileId) {
      const photo = escort.photoFileId;
      await this.files.markDeleted(
        tx,
        { id: photo, purpose: 'child_escort_photo' },
        'retention',
      );
      after?.push(() => this.files.purge(photo).then(() => undefined));
    }
    await this.audit.record(tx, {
      action: 'child_escort.revoked',
      targetId: escort.id,
      metadata: {
        controlId: escort.controlId,
        kind: escort.kind,
        reasonCode: reason,
      },
    });
  }
}

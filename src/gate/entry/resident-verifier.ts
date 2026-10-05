import { Injectable } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { firstNameOf } from '../../core/common/http/personal';
import { FilesService } from '../../core/files/files.service';
import {
  ENTRY_SKEW_STEPS,
  EntrySecrets,
  entryStep,
  macsEqual,
  type EntryQr,
} from './entry-secrets';
import type { VerifyResult } from '../entries/verify.service';
import type { Refusal } from '../entries/subjects';

/**
 * A scanned resident QR at the gate (ADR 0031). Read-only: it writes no
 * `gate_entries` row, no audit entry and no "last used" time; the gate
 * confirms identity, it does not track residents' movements.
 *
 * Order, so a forged QR reveals nothing:
 * 1. the mac for the claimed step, from the derived secret, compared in
 *    constant time, **before any database read**: a wrong mac, a wrong
 *    credential id and another compound's credential are all the unknown
 *    answer (`null`);
 * 2. only a genuine mac can say `expired_qr` (a step outside current ±1);
 * 3. then the credential, the account and where it lives, as of now.
 */
@Injectable()
export class ResidentVerifier {
  constructor(
    private readonly secrets: EntrySecrets,
    private readonly community: CommunityGatePort,
    private readonly files: FilesService,
  ) {}

  /** Null is the unknown-code answer. */
  async verify(
    tx: TenantTxClient,
    tenantId: string,
    qr: EntryQr,
    nowMs: number = Date.now(),
  ): Promise<VerifyResult | null> {
    const found = await this.resolve(tx, tenantId, qr, nowMs);
    if (found.kind === 'unknown') return null;
    if (found.kind === 'refused') return refused(found.reason);

    const codes = await this.community.unitCodes(tx, found.unitIds);
    const photo = await this.files.readUrl(tx, found.photoFileId);
    return {
      result: 'valid',
      subject: 'resident',
      reason: null,
      subjectId: null,
      next: null,
      display: {
        unitCode: null,
        passKind: null,
        partySize: null,
        workerName: null,
        capacity: null,
        photo: null,
        // Only the first word of the name: never the full name.
        firstName: firstNameOf(found.fullName),
        unitCodes: [...codes.values()].sort(),
        photoUrl: photo?.url ?? null,
      },
    };
  }

  /**
   * Who a scanned resident QR belongs to, and nothing else: no name, no
   * photo, no unit list (ADR 0035: a parcel hand-over records the recipient
   * on the parcel only). The same checks in the same order as `verify`, so
   * a forged QR reveals nothing here either: `unknown` is the unknown-code
   * answer, `refused` a genuine QR that no longer opens the door.
   */
  async identify(
    tx: TenantTxClient,
    tenantId: string,
    qr: EntryQr,
    nowMs: number = Date.now(),
  ): Promise<
    | { kind: 'ok'; accountId: string }
    | { kind: 'unknown' }
    | { kind: 'refused'; reason: Refusal }
  > {
    const found = await this.resolve(tx, tenantId, qr, nowMs);
    return found.kind === 'ok'
      ? { kind: 'ok', accountId: found.accountId }
      : found;
  }

  private async resolve(
    tx: TenantTxClient,
    tenantId: string,
    qr: EntryQr,
    nowMs: number,
  ): Promise<
    | {
        kind: 'ok';
        accountId: string;
        fullName: string | null;
        photoFileId: string | null;
        unitIds: string[];
      }
    | { kind: 'unknown' }
    | { kind: 'refused'; reason: Refusal }
  > {
    const expected = this.secrets.macFor(tenantId, qr.credentialId, qr.step);
    if (!macsEqual(expected, qr.mac)) return { kind: 'unknown' };
    if (Math.abs(qr.step - entryStep(nowMs)) > ENTRY_SKEW_STEPS)
      return { kind: 'refused', reason: 'expired_qr' };

    const credential = await tx.entryCredential.findUnique({
      where: { id: qr.credentialId },
    });
    // A genuine mac for a credential that does not exist cannot happen
    // without the key: the unknown answer.
    if (!credential) return { kind: 'unknown' };
    const account = await tx.account.findUnique({
      where: { id: credential.accountId },
      select: { status: true, fullName: true, photoFileId: true },
    });
    if (account?.status !== 'active')
      return { kind: 'refused', reason: 'account_inactive' };
    if (credential.revokedAt) return { kind: 'refused', reason: 'revoked' };
    const unitIds = await this.community.unitsWhere(
      tx,
      credential.accountId,
      'gateEntry',
    );
    if (unitIds.length === 0)
      return { kind: 'refused', reason: 'not_resident' };
    return {
      kind: 'ok',
      accountId: credential.accountId,
      fullName: account.fullName,
      photoFileId: account.photoFileId,
      unitIds,
    };
  }
}

function refused(reason: Refusal): VerifyResult {
  return {
    result: 'invalid',
    subject: 'resident',
    reason,
    subjectId: null,
    next: null,
    display: null,
  };
}

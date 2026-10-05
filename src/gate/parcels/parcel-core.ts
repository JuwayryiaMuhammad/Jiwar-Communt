import { Injectable } from '@nestjs/common';
import type {
  Parcel,
  ParcelActorSide,
  ParcelCarrier,
  ParcelCredential,
  ParcelEventKind,
  ParcelMethod,
  ParcelStatus,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { ParcelTokens } from './parcel-tokens';

/** The idempotency resource of a parcel write that answers with the parcel. */
export const PARCEL_RESOURCE = 'parcel';

export const parcelNotFound = () =>
  appError.notFound(ErrorCode.PARCEL_NOT_FOUND, 'Parcel not found');

/** The parcel is not in a status that allows this (409, params.status). */
export const stateConflict = (status: ParcelStatus) =>
  appError.conflict(
    ErrorCode.PARCEL_STATE_CONFLICT,
    'The parcel is not in a status that allows this',
    { params: { status } },
  );

/** What the guard sees of a parcel: never a resident, never the label. */
export interface GateParcel {
  id: string;
  number: number;
  unitCode: string;
  carrier: ParcelCarrier;
  pieces: number;
  status: ParcelStatus;
  receivedAt: Date;
  handedOverAt: Date | null;
  rejectedAt: Date | null;
  returnedAt: Date | null;
  /** False once the photo is gone (30 days after the hand-over or return). */
  hasPhoto: boolean;
}

/** One line of a parcel's history: no names, no account ids. */
export interface ParcelEventItem {
  kind: ParcelEventKind;
  actorSide: ParcelActorSide;
  method: ParcelMethod | null;
  reasonCode: string | null;
  at: Date;
}

export interface GateParcelDetail extends GateParcel {
  photo: PresignedRead | null;
  handoverPhoto: PresignedRead | null;
  events: ParcelEventItem[];
}

export interface NewEvent {
  parcelId: string;
  kind: ParcelEventKind;
  side: ParcelActorSide;
  actorId?: string | null;
  method?: ParcelMethod | null;
  reasonCode?: string | null;
}

/** Why a parcel's credentials end with it (the CHECK `parcel_credentials_end`). */
export type CredentialEnd =
  'handed_over' | 'rejected' | 'returned' | 'revoked' | 'authorizer_left';

/**
 * What every parcel service shares (ADR 0035): the row lock that serializes
 * every transition, the append-only event log, the credentials and what the
 * guard sees.
 *
 * Lock order, as in ADR 0034: **account rows first (in id order), then
 * parcel rows (in id order)**. Every transition locks the parcel before it
 * reads its status or its credentials.
 */
@Injectable()
export class ParcelCore {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tokens: ParcelTokens,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
  ) {}

  /** The parcel's row lock, held to the end of the transaction. */
  async lock(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM parcels WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /**
   * The caller's own account row, shared: a resident's write takes it
   * before the parcel (ADR 0034's order), so it queues behind a lifecycle
   * hook that holds the row exclusively (a residence change, a freeze) and
   * then sees its commit. The account must still be active under the lock.
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    const accountId = this.ctx.accountId;
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR SHARE`;
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (account?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /** Locks the parcels in id order (hooks that touch several). */
  async lockMany(tx: TenantTxClient, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await tx.$queryRaw`SELECT id FROM parcels WHERE id = ANY(${[...ids]}::uuid[]) ORDER BY id FOR UPDATE`;
  }

  /** Locks, then reads: the status seen is the one the lock protects. */
  async lockedOrThrow(tx: TenantTxClient, id: string): Promise<Parcel> {
    await this.lock(tx, id);
    const parcel = await tx.parcel.findUnique({ where: { id } });
    if (!parcel) throw parcelNotFound();
    return parcel;
  }

  async event(tx: TenantTxClient, e: NewEvent): Promise<void> {
    await tx.parcelEvent.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        parcelId: e.parcelId,
        kind: e.kind,
        actorSide: e.side,
        actorId: e.actorId ?? null,
        method: e.method ?? null,
        reasonCode: e.reasonCode ?? null,
      },
    });
  }

  /**
   * Ends every live credential of the parcel: the hashes go, so the code
   * and the QR are dead at commit. A delegate's name goes with a credential
   * that ends for any reason but the hand-over (which keeps it for the
   * retention period, so the people of the unit can see who collected).
   */
  async endCredentials(
    tx: TenantTxClient,
    parcelId: string,
    reason: CredentialEnd,
  ): Promise<void> {
    await tx.parcelCredential.updateMany({
      where: { parcelId, endedAt: null },
      data: {
        codeHash: null,
        qrTokenHash: null,
        endedAt: new Date(),
        endReason: reason,
        ...(reason === 'handed_over' ? {} : { delegateName: null }),
      },
    });
  }

  /** The live delegate credential of a parcel, if any. */
  delegateOf(
    tx: TenantTxClient,
    parcelId: string,
  ): Promise<ParcelCredential | null> {
    return tx.parcelCredential.findFirst({
      where: { parcelId, kind: 'delegate', endedAt: null },
    });
  }

  /**
   * The code and the QR of a live credential, derived again. Null when the
   * derived code no longer matches the stored hash (PARCEL_TOKEN_KEY was
   * rotated): the credential is stranded and shows nothing (ADR 0035).
   */
  pickupOf(
    credential: ParcelCredential | null,
  ): { code: string; qrPayload: string } | null {
    if (!credential || credential.endedAt || !credential.codeHash) return null;
    const secret = this.tokens.secretOf(
      credential.tenantId,
      credential.id,
      credential.attempt,
    );
    return secret.codeHash === credential.codeHash
      ? { code: secret.code, qrPayload: secret.qrPayload }
      : null;
  }

  /** The compound's holding periods (ADR 0035), read in the caller's tx. */
  settings(tx: TenantTxClient) {
    return tx.parcelSettings.findUniqueOrThrow({
      where: { tenantId: this.ctx.txTenantId },
    });
  }

  async unitCodeOf(tx: TenantTxClient, unitId: string): Promise<string> {
    return this.community.unitCode(tx, unitId);
  }

  unitCodes(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, string>> {
    return this.community.unitCodes(tx, unitIds);
  }

  /** The residents of the unit who may collect: the capability decides. */
  eligibleOf(tx: TenantTxClient, unitId: string): Promise<string[]> {
    return this.community.holders(tx, unitId, 'parcels');
  }

  /** Whether the account is eligible for the unit right now. */
  async isEligible(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<boolean> {
    const caps = await this.community.placeIn(tx, accountId, unitId);
    return caps?.parcels === true;
  }

  gateParcel(parcel: Parcel, unitCode: string): GateParcel {
    return {
      id: parcel.id,
      number: parcel.number,
      unitCode,
      carrier: parcel.carrier,
      pieces: parcel.pieces,
      status: parcel.status,
      receivedAt: parcel.receivedAt,
      handedOverAt: parcel.handedOverAt,
      rejectedAt: parcel.rejectedAt,
      returnedAt: parcel.returnedAt,
      hasPhoto: parcel.photoFileId !== null,
    };
  }

  async gateParcelOf(tx: TenantTxClient, parcel: Parcel): Promise<GateParcel> {
    return this.gateParcel(parcel, await this.unitCodeOf(tx, parcel.unitId));
  }

  /** The parcel's history, oldest first: sides and codes, never an account. */
  async events(
    tx: TenantTxClient,
    parcelId: string,
  ): Promise<ParcelEventItem[]> {
    const rows = await tx.parcelEvent.findMany({
      where: { parcelId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((e) => ({
      kind: e.kind,
      actorSide: e.actorSide,
      method: e.method,
      reasonCode: e.reasonCode,
      at: e.at,
    }));
  }

  /** The photo URLs of a parcel (presigning is local), for no-store responses. */
  async photos(
    tx: TenantTxClient,
    parcel: Parcel,
  ): Promise<{
    photo: PresignedRead | null;
    handoverPhoto: PresignedRead | null;
  }> {
    return {
      photo: await this.files.readUrl(tx, parcel.photoFileId),
      handoverPhoto: await this.files.readUrl(tx, parcel.handoverPhotoFileId),
    };
  }

  async gateParcelDetail(
    tx: TenantTxClient,
    parcel: Parcel,
  ): Promise<GateParcelDetail> {
    return {
      ...(await this.gateParcelOf(tx, parcel)),
      ...(await this.photos(tx, parcel)),
      events: await this.events(tx, parcel.id),
    };
  }
}

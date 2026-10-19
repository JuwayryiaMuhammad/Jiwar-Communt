import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { BlocklistCore } from '../blocklist/blocklist-core';
import { dbNow } from '../db-clock';
import { LockdownCore } from '../lockdown/lockdown-core';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { BundleBuilder, type BundleSections } from './bundle-builder';
import { bundleValidUntil } from './bundle-rules';
import { BundleSigner } from './bundle-signer';
import {
  deviceRevoked,
  DeviceEnvelopes,
  type DeviceEnvelope,
} from './device-envelopes';
import { newSalt } from './offline-tags';

/** A device downloads this many bundles a minute at most. */
export const BUNDLE_RATE_PER_MINUTE = 4;

/** The bundle as signed: its header, then its sections. */
export interface BundleBody extends BundleSections {
  v: 1;
  bundleId: string;
  tenantId: string;
  deviceId: string;
  version: number;
  shiftId: string;
  gateId: string;
  guardId: string;
  issuedAt: string;
  validUntil: string;
  keyVersion: number;
  timezone: string;
  /** The bundle's own key for its short tags, base64url (32 bytes). */
  salt: string;
}

export interface IssuedBundle {
  keyVersion: number;
  /** The bundle's JSON in base64url: what the signature covers. */
  body: string;
  signature: string;
  serverTime: Date;
}

export interface BundleKeys {
  keys: { version: number; publicKey: string; current: boolean }[];
  serverTime: Date;
}

/**
 * The gate bundle (ADR 0057): what a device on duty at a gate downloads to
 * decide entries without network, signed by the server.
 *
 * Per device, shift and gate; valid until the shift's planned end, a day at
 * most (bundle-rules.ts); numbered per device. The server keeps its number,
 * validity, key id, the SHA-256 of what it sent and its counts, never what
 * it carried.
 *
 * Lock order: the guard's account (FOR SHARE), their shift (FOR SHARE), the
 * device (FOR UPDATE), the lockdown row (FOR SHARE), the blocklist
 * (shared): the snapshot is consistent with every lockdown and ban.
 */
@Injectable()
export class GateBundlesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly safety: SafetyCore,
    private readonly shifts: ShiftsService,
    private readonly envelopes: DeviceEnvelopes,
    private readonly rateLimit: RateLimitService,
    private readonly lockdown: LockdownCore,
    private readonly blocklist: BlocklistCore,
    private readonly settings: TenantSettingsService,
    private readonly builder: BundleBuilder,
    private readonly signer: BundleSigner,
  ) {}

  /** The keys a bundle may be signed with: the device checks the key id. */
  keys(): Promise<BundleKeys> {
    return this.tenantTx.withTenantTx(async (tx) => ({
      keys: this.signer.publicKeys(),
      serverTime: await dbNow(tx),
    }));
  }

  issue(envelope: DeviceEnvelope): Promise<IssuedBundle> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      const { device, now } = await this.envelopes.open(tx, envelope, 'bundle');
      if (device.revokedAt) throw deviceRevoked();
      await this.rateLimit.consume(
        `gate-bundle:device:${device.id}`,
        BUNDLE_RATE_PER_MINUTE,
        60,
      );
      await this.lockdown.lockState(tx, 'share');
      await this.blocklist.lockRead(tx);
      const slot = await tx.guardRosterSlot.findFirst({
        where: { shiftId: shift.id },
        select: { endsAt: true },
      });
      const validUntil = bundleValidUntil(now, slot?.endsAt ?? null);
      const { timezone } = await this.settings.inTx(tx, tenantId);
      const bundleId = newId();
      const salt = newSalt();
      const version = device.bundleVersion + 1;
      const { sections, counts } = await this.builder.build(tx, {
        bundleId,
        salt,
        issuedAt: now,
        validUntil,
        gateId: shift.gateId,
        tenantId,
        timezone,
      });
      const bundle: BundleBody = {
        v: 1,
        bundleId,
        tenantId,
        deviceId: device.id,
        version,
        shiftId: shift.id,
        gateId: shift.gateId,
        guardId: this.ctx.accountId,
        issuedAt: now.toISOString(),
        validUntil: validUntil.toISOString(),
        keyVersion: this.signer.keyVersion,
        timezone,
        salt: salt.toString('base64url'),
        ...sections,
      };
      const body = Buffer.from(JSON.stringify(bundle), 'utf8').toString(
        'base64url',
      );
      await tx.gateOfflineBundle.create({
        data: {
          id: bundleId,
          tenantId,
          deviceId: device.id,
          version,
          shiftId: shift.id,
          gateId: shift.gateId,
          guardAccountId: this.ctx.accountId,
          issuedAt: now,
          validUntil,
          keyVersion: this.signer.keyVersion,
          contentSha256: createHash('sha256').update(body).digest('hex'),
          counts,
        },
      });
      await tx.gateDevice.update({
        where: { id: device.id },
        data: { bundleVersion: version, lastBundleAt: now, lastSeenAt: now },
      });
      return {
        keyVersion: this.signer.keyVersion,
        body,
        signature: this.signer.sign(body),
        serverTime: now,
      };
    });
  }
}

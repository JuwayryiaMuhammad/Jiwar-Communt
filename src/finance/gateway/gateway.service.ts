import { Injectable, Logger } from '@nestjs/common';
import type { FinanceGateway, FinanceGatewayMode } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { PlatformAuditService } from '../../core/audit/platform-audit.service';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { PaymobCredentials } from '../paymob/paymob-client';
import {
  CredentialVault,
  last4,
  VaultOpenError,
  type VaultField,
} from './credential-vault';
import type { SetGatewayDto } from './dto/gateway.dto';
import type { GatewayView } from './views/gateway.view';

/** Who changes a compound's gateway: one of its managers, or the platform. */
export type GatewayActor = { accountId: string } | 'platform';

const FIELDS = [
  ['secretKey', 'secret_key', 'secretKeyEnc'],
  ['publicKey', 'public_key', 'publicKeyEnc'],
  ['hmacSecret', 'hmac_secret', 'hmacSecretEnc'],
  ['cardIntegrationId', 'card_integration_id', 'cardIntegrationEnc'],
  ['walletIntegrationId', 'wallet_integration_id', 'walletIntegrationEnc'],
] as const;

type Plain = Record<(typeof FIELDS)[number][0], string | null>;

/** What the webhook and the checkout need: credentials, and whether payment is on. */
export interface OpenGateway {
  creds: PaymobCredentials;
  mode: FinanceGatewayMode;
  /** Configured, enabled, not disabled by the platform. */
  online: boolean;
}

/**
 * A compound's online payment account (ADR 0046): its Paymob credentials,
 * sealed by the vault and shown by their last four characters only; the
 * manager's on/off switch and the platform's off switch. Every method runs
 * inside the caller's tenant transaction.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly vault: CredentialVault,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  async view(tx: TenantTxClient, tenantId: string): Promise<GatewayView> {
    const [settings, gateway] = await this.read(tx, tenantId);
    return {
      configured: gateway !== null,
      mode: gateway?.mode ?? null,
      last4: gateway
        ? {
            secretKey: gateway.secretKeyLast4,
            publicKey: gateway.publicKeyLast4,
            hmacSecret: gateway.hmacSecretLast4,
            cardIntegrationId: gateway.cardIntegrationLast4,
            walletIntegrationId: gateway.walletIntegrationLast4,
          }
        : null,
      onlineEnabled: settings.onlineEnabled,
      platformDisabled: settings.platformDisabled,
      available:
        gateway !== null &&
        settings.onlineEnabled &&
        !settings.platformDisabled &&
        this.vault.available &&
        this.vault.canOpen(gateway.keyVersion),
      updatedBy: gateway
        ? gateway.updatedByPlatform
          ? 'platform'
          : 'manager'
        : null,
      updatedAt: gateway?.updatedAt ?? null,
    };
  }

  /** Replaces every credential at once; audits which fields changed, never a value. */
  async set(
    tx: TenantTxClient,
    tenantId: string,
    dto: SetGatewayDto,
    actor: GatewayActor,
  ): Promise<void> {
    if (!this.vault.available) throw vaultUnavailable();
    const prefix = dto.mode === 'live' ? '_live_' : '_test_';
    const fields = [
      ...(dto.secretKey.startsWith(`egy_sk${prefix}`) ? [] : ['secretKey']),
      ...(dto.publicKey.startsWith(`egy_pk${prefix}`) ? [] : ['publicKey']),
    ].map((field) => ({ field, code: FieldErrorCode.GATEWAY_MODE_MISMATCH }));
    if (fields.length) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'The keys do not match the mode',
        { fields },
      );
    }
    const [, before] = await this.read(tx, tenantId, { lock: true });
    const next: Plain = {
      secretKey: dto.secretKey,
      publicKey: dto.publicKey,
      hmacSecret: dto.hmacSecret,
      cardIntegrationId: String(dto.cardIntegrationId),
      walletIntegrationId:
        dto.walletIntegrationId == null
          ? null
          : String(dto.walletIntegrationId),
    };
    const previous = before ? this.tryOpenAll(tenantId, before) : null;
    const fieldsChanged = FIELDS.map(([name]) => name).filter(
      (name) => !previous || previous[name] !== next[name],
    );
    const sealed = (field: VaultField, value: string) =>
      this.vault.seal(tenantId, field, value);
    const enc = {
      secretKeyEnc: sealed('secret_key', next.secretKey!),
      publicKeyEnc: sealed('public_key', next.publicKey!),
      hmacSecretEnc: sealed('hmac_secret', next.hmacSecret!),
      cardIntegrationEnc: sealed(
        'card_integration_id',
        next.cardIntegrationId!,
      ),
      walletIntegrationEnc:
        next.walletIntegrationId === null
          ? null
          : sealed('wallet_integration_id', next.walletIntegrationId),
    };
    const data = {
      mode: dto.mode,
      keyVersion: enc.secretKeyEnc.keyVersion,
      secretKeyEnc: enc.secretKeyEnc.ciphertext,
      publicKeyEnc: enc.publicKeyEnc.ciphertext,
      hmacSecretEnc: enc.hmacSecretEnc.ciphertext,
      cardIntegrationEnc: enc.cardIntegrationEnc.ciphertext,
      walletIntegrationEnc: enc.walletIntegrationEnc?.ciphertext ?? null,
      secretKeyLast4: last4(next.secretKey!),
      publicKeyLast4: last4(next.publicKey!),
      hmacSecretLast4: last4(next.hmacSecret!),
      cardIntegrationLast4: last4(next.cardIntegrationId!),
      walletIntegrationLast4:
        next.walletIntegrationId === null
          ? null
          : last4(next.walletIntegrationId),
      updatedById: actor === 'platform' ? null : actor.accountId,
      updatedByPlatform: actor === 'platform',
    };
    await tx.financeGateway.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    const metadata = { fieldsChanged, mode: dto.mode };
    if (actor === 'platform') {
      await this.platformAudit.record(tx, {
        action: 'tenant.payment_gateway_set',
        targetId: tenantId,
        targetTenantId: tenantId,
        metadata,
      });
    } else {
      await this.audit.record(tx, {
        action: 'finance_gateway.set',
        targetId: tenantId,
        metadata,
      });
    }
  }

  /** The manager's switch. Turning it on needs credentials and the key. */
  async setOnline(
    tx: TenantTxClient,
    tenantId: string,
    onlineEnabled: boolean,
  ): Promise<void> {
    const [settings, gateway] = await this.read(tx, tenantId, { lock: true });
    if (onlineEnabled) {
      if (!this.vault.available) throw vaultUnavailable();
      if (!gateway) {
        throw appError.conflict(
          ErrorCode.GATEWAY_NOT_CONFIGURED,
          'Set the credentials first',
        );
      }
    }
    if (settings.onlineEnabled === onlineEnabled) return;
    await tx.financeSettings.update({
      where: { tenantId },
      data: { onlineEnabled },
    });
    await this.audit.record(tx, {
      action: 'finance_gateway.toggled',
      targetId: tenantId,
      metadata: { onlineEnabled },
    });
  }

  /** The platform's switch: off wins over the manager's on. */
  async setPlatformDisabled(
    tx: TenantTxClient,
    tenantId: string,
    platformDisabled: boolean,
  ): Promise<void> {
    const [settings] = await this.read(tx, tenantId, { lock: true });
    if (settings.platformDisabled === platformDisabled) return;
    await tx.financeSettings.update({
      where: { tenantId },
      data: { platformDisabled },
    });
    await this.platformAudit.record(tx, {
      action: 'tenant.payment_gateway_toggled',
      targetId: tenantId,
      targetTenantId: tenantId,
      metadata: { platformDisabled },
    });
  }

  /**
   * The compound's credentials, opened, whether or not payment is on (the
   * webhook still verifies what was paid before a switch-off). Null when
   * there are none or they cannot be opened (no key, unknown version,
   * tampering): the caller answers as for an unknown compound.
   */
  async open(
    tx: TenantTxClient,
    tenantId: string,
  ): Promise<OpenGateway | null> {
    const [settings, gateway] = await this.read(tx, tenantId);
    if (!gateway) return null;
    const plain = this.tryOpenAll(tenantId, gateway);
    if (!plain) return null;
    return {
      creds: {
        secretKey: plain.secretKey!,
        publicKey: plain.publicKey!,
        hmacSecret: plain.hmacSecret!,
        cardIntegrationId: Number(plain.cardIntegrationId),
        walletIntegrationId:
          plain.walletIntegrationId === null
            ? null
            : Number(plain.walletIntegrationId),
      },
      mode: gateway.mode,
      online: settings.onlineEnabled && !settings.platformDisabled,
    };
  }

  private async read(
    tx: TenantTxClient,
    tenantId: string,
    opts: { lock?: boolean } = {},
  ) {
    if (opts.lock) {
      // One change at a time per compound: the settings row is the lock.
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    }
    const settings = await tx.financeSettings.findUniqueOrThrow({
      where: { tenantId },
    });
    const gateway = await tx.financeGateway.findUnique({ where: { tenantId } });
    return [settings, gateway] as const;
  }

  private tryOpenAll(tenantId: string, row: FinanceGateway): Plain | null {
    try {
      const open = (field: VaultField, value: Uint8Array) =>
        this.vault.open(tenantId, field, value, row.keyVersion);
      return {
        secretKey: open('secret_key', row.secretKeyEnc),
        publicKey: open('public_key', row.publicKeyEnc),
        hmacSecret: open('hmac_secret', row.hmacSecretEnc),
        cardIntegrationId: open('card_integration_id', row.cardIntegrationEnc),
        walletIntegrationId: row.walletIntegrationEnc
          ? open('wallet_integration_id', row.walletIntegrationEnc)
          : null,
      };
    } catch (error) {
      if (!(error instanceof VaultOpenError)) throw error;
      this.logger.error(
        `gateway credentials of a compound cannot be opened (key version ${row.keyVersion})`,
      );
      return null;
    }
  }
}

export function vaultUnavailable() {
  return appError.serviceUnavailable(
    ErrorCode.PAYMENT_VAULT_UNAVAILABLE,
    'The server holds no payment credentials key',
  );
}

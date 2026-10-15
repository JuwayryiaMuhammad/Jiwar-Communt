import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { CredentialVault, type VaultField } from './credential-vault';

/** A compound that takes online payment, as the boot check sees it. */
export interface EnabledGateway {
  tenantId: string;
  keyVersion: number;
}

/**
 * Why the app must not start (ADR 0046), from what is enabled and what the
 * environment holds. Names variables and compound ids, never a value.
 */
export function gatewayBootProblems(input: {
  enabled: readonly EnabledGateway[];
  keyPresent: boolean;
  webhookBase: string | undefined;
  canOpen: (keyVersion: number) => boolean;
}): string[] {
  if (input.enabled.length === 0) return [];
  const ids = (list: readonly EnabledGateway[]) =>
    list.map((g) => g.tenantId).join(', ');
  const problems: string[] = [];
  if (!input.keyPresent) {
    problems.push(
      `PAYMENT_CREDENTIALS_KEY is not set, but ${input.enabled.length} compound(s) take online payment: ${ids(input.enabled)}`,
    );
  }
  if (!input.webhookBase) {
    problems.push(
      `PAYMENT_WEBHOOK_BASE_URL is not set, but ${input.enabled.length} compound(s) take online payment: ${ids(input.enabled)}`,
    );
  }
  const stranded = input.enabled.filter((g) => !input.canOpen(g.keyVersion));
  if (input.keyPresent && stranded.length) {
    const versions = [...new Set(stranded.map((g) => g.keyVersion))].sort();
    problems.push(
      `no key for version(s) ${versions.join(', ')} in PAYMENT_CREDENTIALS_KEY / PAYMENT_CREDENTIALS_PREVIOUS_KEYS, used by: ${ids(stranded)}`,
    );
  }
  return problems;
}

/**
 * The vault's keys against the database (ADR 0046):
 *
 * - at boot, refuses to start when a compound takes online payment and the
 *   key, the webhook origin or the key of its credentials' version is
 *   missing (skipped under NODE_ENV=test, where suites call `check()`);
 * - `reencryptAll()` re-seals every gateway with the current key, for
 *   `pnpm finance:reencrypt-gateways` during a rotation.
 *
 * Both walk every compound with runInTenantUnsafe (this file is named in
 * eslint.config.mjs): there is no request tenant at boot or in a CLI.
 */
@Injectable()
export class GatewayKeys implements OnApplicationBootstrap {
  private readonly logger = new Logger(GatewayKeys.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly vault: CredentialVault,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return;
    await this.check();
  }

  /** Throws (so Nest aborts `listen`) with every problem found. */
  async check(): Promise<void> {
    const problems = gatewayBootProblems({
      enabled: await this.enabledGateways(),
      keyPresent: this.vault.available,
      webhookBase: this.config.get('PAYMENT_WEBHOOK_BASE_URL', { infer: true }),
      canOpen: (v) => this.vault.canOpen(v),
    });
    if (problems.length) {
      throw new Error(
        `Online payment is misconfigured (ADR 0046):\n- ${problems.join('\n- ')}`,
      );
    }
  }

  /** Compounds whose gateway is configured, enabled and not switched off. */
  async enabledGateways(): Promise<EnabledGateway[]> {
    const out: EnabledGateway[] = [];
    for (const t of await this.tenants()) {
      const row = await this.tenantTx.runInTenantUnsafe(t.id, (tx) =>
        tx.financeSettings.findUnique({
          where: { tenantId: t.id },
          select: {
            onlineEnabled: true,
            platformDisabled: true,
            tenant: {
              select: { financeGateway: { select: { keyVersion: true } } },
            },
          },
        }),
      );
      const gateway = row?.tenant.financeGateway;
      if (row?.onlineEnabled && !row.platformDisabled && gateway) {
        out.push({ tenantId: t.id, keyVersion: gateway.keyVersion });
      }
    }
    return out;
  }

  /**
   * Re-seals with the current key every gateway sealed under another
   * version. Idempotent: a second run changes nothing. Returns how many
   * compounds were re-sealed.
   */
  async reencryptAll(): Promise<number> {
    const current = this.vault.currentVersion;
    if (current === null) throw new Error('PAYMENT_CREDENTIALS_KEY is not set');
    let count = 0;
    for (const t of await this.tenants()) {
      const changed = await this.tenantTx.runInTenantUnsafe(
        t.id,
        async (tx) => {
          const rows = await tx.$queryRaw<{ key_version: number }[]>`
          SELECT key_version FROM finance_gateways
           WHERE tenant_id = ${t.id}::uuid FOR UPDATE`;
          if (!rows.length || rows[0].key_version === current) return false;
          const g = await tx.financeGateway.findUniqueOrThrow({
            where: { tenantId: t.id },
          });
          const reseal = (field: VaultField, value: Uint8Array) =>
            this.vault.seal(
              t.id,
              field,
              this.vault.open(t.id, field, value, g.keyVersion),
            ).ciphertext;
          await tx.financeGateway.update({
            where: { tenantId: t.id },
            data: {
              keyVersion: current,
              secretKeyEnc: reseal('secret_key', g.secretKeyEnc),
              publicKeyEnc: reseal('public_key', g.publicKeyEnc),
              hmacSecretEnc: reseal('hmac_secret', g.hmacSecretEnc),
              cardIntegrationEnc: reseal(
                'card_integration_id',
                g.cardIntegrationEnc,
              ),
              walletIntegrationEnc: g.walletIntegrationEnc
                ? reseal('wallet_integration_id', g.walletIntegrationEnc)
                : null,
            },
          });
          return true;
        },
      );
      if (changed) count += 1;
    }
    this.logger.log(`re-sealed the gateways of ${count} compound(s)`);
    return count;
  }

  private tenants(): Promise<{ id: string }[]> {
    return this.globalDb.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  }
}

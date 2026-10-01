import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { SweepRunner } from '../sweep/sweep-runner';
import { IDEMPOTENCY_TTL_MS, IdempotencyReplaySignal } from './idempotency-key';

export const IDEMPOTENCY_PURGE_SWEEP = 'idempotency.purge';

/** The resource an idempotent write created or changed. */
export interface ResourceRef {
  type: string;
  id: string;
}

/** Re-renders the response of a write from its resource (a lost body). */
export type Renderer = (id: string) => Promise<unknown>;

export interface StoredKey {
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  resourceType: string;
  resourceId: string;
  expiresAt: Date;
}

/**
 * Idempotent writes (ADR 0028). A route marked `@Idempotent()` puts the
 * request's key in the context; the service claims it **inside its own
 * transaction** with `claim(tx, ref)`, so the key commits or rolls back with
 * the write. A concurrent duplicate blocks on the key's primary key until
 * the first commits, then replays. The response body is stored after the
 * write; a body lost to a crash is re-rendered from the resource ref by the
 * renderer the owning module registered.
 */
@Injectable()
export class IdempotencyService implements OnModuleInit {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly renderers = new Map<string, Renderer>();

  constructor(
    private readonly cls: ClsService<AppClsStore>,
    private readonly ctx: RequestContext,
    private readonly prisma: PrismaService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(IDEMPOTENCY_PURGE_SWEEP, (now) =>
      this.sweep.forEachTenant(async (tx) => {
        const { count } = await tx.idempotencyKey.deleteMany({
          where: { expiresAt: { lte: now } },
        });
        return count;
      }),
    );
  }

  /** Registered at startup by the module that owns `type`. */
  renderer(type: string, render: Renderer): void {
    if (this.renderers.has(type))
      throw new Error(`Idempotency renderer ${type} is registered twice`);
    this.renderers.set(type, render);
  }

  /**
   * Call first in the action's transaction (before any other write). A
   * no-op without an Idempotency-Key. Throws IdempotencyReplaySignal when a
   * committed duplicate holds the key.
   */
  async claim(tx: TenantTxClient, ref: ResourceRef): Promise<void> {
    const req = this.cls.isActive() ? this.cls.get('idempotency') : undefined;
    if (!req) return;
    if (!this.renderers.has(ref.type))
      throw new Error(`No idempotency renderer for ${ref.type}`);
    if (req.claimed) throw new Error('An Idempotency-Key was claimed twice');
    const tenantId = this.cls.get('txTenantId');
    if (!tenantId) throw new Error('claim must run inside a TenantTx');
    try {
      await tx.idempotencyKey.create({
        data: {
          tenantId,
          accountId: this.ctx.accountId,
          key: req.key,
          requestHash: req.hash,
          route: req.route,
          resourceType: ref.type,
          resourceId: ref.id,
          responseStatus: req.status,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new IdempotencyReplaySignal();
      throw error;
    }
    req.claimed = true;
  }

  /** The caller's live key, if any (an expired one is removed first). */
  async find(key: string): Promise<StoredKey | null> {
    const where = {
      tenantId_accountId_key: {
        tenantId: this.ctx.tenantId,
        accountId: this.ctx.accountId,
        key,
      },
    };
    const row = await this.prisma.tenant.idempotencyKey.findUnique({ where });
    if (!row) return null;
    if (row.expiresAt <= new Date()) {
      await this.prisma.tenant.idempotencyKey.deleteMany({
        where: {
          tenantId: row.tenantId,
          accountId: row.accountId,
          key,
          expiresAt: row.expiresAt,
        },
      });
      return null;
    }
    return row;
  }

  /** The stored response, or 409 IDEMPOTENCY_CONFLICT for another request. */
  async replay(
    row: StoredKey,
    hash: string,
  ): Promise<{ status: number; body: unknown }> {
    if (row.requestHash !== hash)
      throw appError.conflict(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'This Idempotency-Key was used for a different request',
      );
    if (row.responseBody !== null && row.responseBody !== undefined)
      return { status: row.responseStatus, body: row.responseBody };
    const render = this.renderers.get(row.resourceType);
    if (!render)
      throw new Error(`No idempotency renderer for ${row.resourceType}`);
    return { status: row.responseStatus, body: await render(row.resourceId) };
  }

  /** Best effort: a lost body is re-rendered on replay. */
  async store(key: string, body: unknown): Promise<void> {
    try {
      await this.prisma.tenant.idempotencyKey.updateMany({
        where: {
          tenantId: this.ctx.tenantId,
          accountId: this.ctx.accountId,
          key,
        },
        data: {
          responseBody: (body ?? null) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(
        `storing an idempotent response failed (${error instanceof Error ? error.name : 'Error'})`,
      );
    }
  }
}

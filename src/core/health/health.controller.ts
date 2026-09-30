import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { appError, ErrorCode } from '../common/errors';
import Redis from 'ioredis';
import { ApiArea } from '../common/http/decorators';
import { Public } from '../common/guards/public.decorator';
import { GlobalDbService } from '../database/global-db.service';
import { REDIS } from '../redis/redis.module';

@ApiArea('health', 'public')
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly globalDb: GlobalDbService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Readiness: database, Redis, and a canary for the tenant setting — a
   * non-empty value outside any transaction means a tenant leaked (ADR 0005).
   */
  @Get()
  async check() {
    const [db, leak, redis] = await Promise.allSettled([
      this.globalDb.ping(),
      this.globalDb.leakedTenantSetting(),
      this.redis.ping(),
    ]);
    const result = {
      db: db.status === 'fulfilled' ? 'up' : 'down',
      redis: redis.status === 'fulfilled' ? 'up' : 'down',
      tenantSettingLeak:
        leak.status === 'fulfilled' ? leak.value !== null : 'unknown',
    };
    const ok =
      result.db === 'up' &&
      result.redis === 'up' &&
      result.tenantSettingLeak === false;
    if (!ok) {
      for (const r of [db, leak, redis]) {
        if (r.status === 'rejected') {
          this.logger.error(
            r.reason instanceof Error ? r.reason.message : String(r.reason),
          );
        }
      }
      throw appError.serviceUnavailable(ErrorCode.NOT_READY, 'Not ready', {
        details: result,
      });
    }
    return { status: 'ok', ...result };
  }
}

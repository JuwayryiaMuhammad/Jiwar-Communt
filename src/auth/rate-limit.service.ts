import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { ErrorCode } from '../common/errors';
import { REDIS } from '../redis/redis.module';

/** Fixed-window counters in Redis. */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Counts a hit and throws 429 once `limit` is exceeded within the window. */
  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const redisKey = `rl:${key}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .exec()) as [[Error | null, number], [Error | null, number]];
    if (count > limit) {
      throw new HttpException(
        {
          message: 'Too many attempts, try again later',
          code: ErrorCode.RATE_LIMITED,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

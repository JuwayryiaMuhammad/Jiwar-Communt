import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { appError, ErrorCode } from '../common/errors';
import { REDIS } from './redis.token';

/** Fixed-window counters in Redis. */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Whether `key` has already had more than `limit` hits in its window,
   * without counting one. For a lockout that only failures feed (ADR 0035).
   */
  async exceeded(key: string, limit: number): Promise<boolean> {
    const count = Number((await this.redis.get(`rl:${key}`)) ?? 0);
    return count > limit;
  }

  /**
   * Counts a hit in a fixed window and never throws: the count so far. For a
   * lockout that only failures feed (ADR 0035).
   */
  async hit(key: string, windowSeconds: number): Promise<number> {
    const redisKey = `rl:${key}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .exec()) as [[Error | null, number], [Error | null, number]];
    return count;
  }

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
      throw appError.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        'Too many attempts, try again later',
      );
    }
  }
}

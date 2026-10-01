import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { AppClsStore } from '../common/cls/app-cls';
import {
  IdempotencyReplaySignal,
  parseIdempotencyKey,
  requestHash,
} from './idempotency-key';
import { IdempotencyService } from './idempotency.service';

export const REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * Runs an `@Idempotent()` route (ADR 0028). Without the header, the route
 * runs as usual. With it: a live key of this account replays its response
 * (409 if the request differs); otherwise the route runs with the key in
 * the context, and its service must claim it in its transaction — a route
 * that returns without claiming is a programming error (500).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const key = parseIdempotencyKey(req.headers['idempotency-key']);
    if (key === undefined) return next.handle();
    const route =
      (req.route as { path?: string } | undefined)?.path ?? req.path;
    const hash = requestHash(req.method, route, req.params, req.body);
    return from(this.run(key, hash, route, res, next));
  }

  private async run(
    key: string,
    hash: string,
    route: string,
    res: Response,
    next: CallHandler,
  ): Promise<unknown> {
    const replay = async () => {
      const row = await this.idempotency.find(key);
      if (!row) throw new Error('Idempotency-Key vanished during a replay');
      const { status, body } = await this.idempotency.replay(row, hash);
      res.status(status);
      res.setHeader(REPLAYED_HEADER, 'true');
      return body;
    };

    if (await this.idempotency.find(key)) return replay();

    const claim = { key, hash, route, status: res.statusCode, claimed: false };
    this.cls.set('idempotency', claim);
    let body: unknown;
    try {
      body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (error) {
      if (error instanceof IdempotencyReplaySignal) return replay();
      throw error;
    } finally {
      this.cls.set('idempotency', undefined);
    }
    if (!claim.claimed)
      throw new Error(
        `${route} is @Idempotent() but its service did not claim the key`,
      );
    await this.idempotency.store(key, body);
    return body;
  }
}

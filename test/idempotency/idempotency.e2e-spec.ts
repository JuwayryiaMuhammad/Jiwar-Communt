import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  Post,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional } from 'class-validator';
import { RequestContext } from '../../src/core/common/cls/request-context';
import { appError, ErrorCode } from '../../src/core/common/errors';
import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import {
  IDEMPOTENCY_PURGE_SWEEP,
  IdempotencyService,
} from '../../src/core/idempotency/idempotency.service';
import { Idempotent } from '../../src/core/idempotency/idempotent.decorator';
import { Notifier } from '../../src/core/notifications/notifier';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers, type Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness, API } from '../setup/http-app';

class ProbeDto {
  @ApiProperty({ type: Number })
  @IsInt()
  n: number;

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  fail?: boolean;

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  slow?: boolean;
}

/**
 * A test-only write: one notification to the caller (the "resource"),
 * claimed first in its transaction, like every idempotent service method.
 */
@Injectable()
class ProbeService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly ctx: RequestContext,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer('probe_note', (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const n = await tx.notification.findFirstOrThrow({
          where: { targetId: id },
        });
        return { id, n: Number((n.params as { unitCode: string }).unitCode) };
      }),
    );
  }

  create(dto: ProbeDto): Promise<{ id: string; n: number }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: 'probe_note', id });
      if (dto.slow) await tx.$executeRaw`SELECT pg_sleep(0.4)`;
      await this.notifier.notify(tx, [this.ctx.accountId], {
        kind: 'worker.entered',
        params: { unitCode: String(dto.n), gateName: 'Probe', workerName: 'P' },
        targetId: id,
      });
      if (dto.fail)
        throw appError.conflict(ErrorCode.CONFLICT, 'The probe failed');
      return { id, n: dto.n };
    });
  }
}

@Controller('probe-idempotent')
class ProbeController {
  constructor(private readonly probe: ProbeService) {}

  @Post()
  @Idempotent()
  create(@Body() dto: ProbeDto) {
    return this.probe.create(dto);
  }

  @Post('forgets')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  forgets(@Body() dto: ProbeDto) {
    return { n: dto.n };
  }
}

@Module({ providers: [ProbeService], controllers: [ProbeController] })
class ProbeModule {}

describe('Idempotency-Key (ADR 0028)', () => {
  let h: HttpHarness;
  let c: ReturnType<typeof communityHelpers>;
  let compound: Compound;
  let token: string;
  let accountId: string;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [ProbeModule] });
    c = communityHelpers(h);
    compound = await c.compound('Idempotency');
    const unit = await c.unit(compound);
    accountId = (await c.resident(compound, [unit.id])).id;
    token = await h.tokenFor({
      sub: accountId,
      tid: compound.tenantId,
      typ: 'resident',
    });
  }, 60_000);

  afterAll(() => h.close());

  const post = (body: object, key?: string, as = token, path = '') => {
    let req = h
      .http()
      .post(`${API}/probe-idempotent${path}`)
      .set('Authorization', `Bearer ${as}`);
    if (key !== undefined) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const notes = (n: number) =>
    c.asManager(compound, () =>
      c.prisma.tenant.notification.count({
        where: { accountId, params: { path: ['unitCode'], equals: String(n) } },
      }),
    );
  const key = () => `k-${newId()}`;

  it('a retry replays the first response and writes once', async () => {
    const k = key();
    const first = await post({ n: 101 }, k).expect(201);
    const again = await post({ n: 101 }, k).expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await notes(101)).toBe(1);
  });

  it('two concurrent duplicates: one write, the same response', async () => {
    const k = key();
    const [x, y] = await Promise.all([
      post({ n: 102, slow: true }, k),
      post({ n: 102, slow: true }, k),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body).toEqual(y.body);
    expect(await notes(102)).toBe(1);
  });

  it('the same key for another request is 409 IDEMPOTENCY_CONFLICT', async () => {
    const k = key();
    await post({ n: 103 }, k).expect(201);
    const res = await post({ n: 104 }, k).expect(409);
    expect((res.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await notes(104)).toBe(0);
  });

  it('without a key every request writes', async () => {
    await post({ n: 105 }).expect(201);
    await post({ n: 105 }).expect(201);
    expect(await notes(105)).toBe(2);
  });

  it('keys are per account', async () => {
    const k = key();
    const other = await c.resident(compound, [(await c.unit(compound)).id]);
    const otherToken = await h.tokenFor({
      sub: other.id,
      tid: compound.tenantId,
      typ: 'resident',
    });
    const mine = await post({ n: 106 }, k).expect(201);
    const theirs = await post({ n: 106 }, k, otherToken).expect(201);
    expect(theirs.body).not.toEqual(mine.body);
  });

  it('a failed action keeps no key: the retry runs again', async () => {
    const k = key();
    await post({ n: 107, fail: true }, k).expect(409);
    expect(await notes(107)).toBe(0);
    await post({ n: 107 }, k).expect(201);
    expect(await notes(107)).toBe(1);
  });

  it('a body lost after the commit is re-rendered from the resource', async () => {
    const k = key();
    const first = await post({ n: 108 }, k).expect(201);
    // The crash: committed, but the body was never stored.
    await c.asManager(compound, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx(
          (tx) =>
            tx.$executeRaw`UPDATE idempotency_keys SET response_body = NULL WHERE key = ${k}`,
        ),
    );
    const again = await post({ n: 108 }, k).expect(201);
    expect(again.body).toEqual(first.body);
    expect(await notes(108)).toBe(1);
  });

  it('a malformed key is a 400 on the header', async () => {
    const res = await post({ n: 109 }, 'short').expect(400);
    expect((res.body as { fields: unknown }).fields).toEqual([
      {
        field: 'Idempotency-Key',
        code: 'INVALID_FORMAT',
        params: { min: 8, max: 128 },
      },
    ]);
  });

  it('a route that does not claim its key fails loudly', async () => {
    await post({ n: 110 }, key(), token, '/forgets').expect(500);
    // Without a key it is an ordinary route.
    await post({ n: 110 }, undefined, token, '/forgets').expect(200);
  });

  it('expired keys are forgotten and purged', async () => {
    const k = key();
    await post({ n: 111 }, k).expect(201);
    const purged = await h.moduleRef
      .get(SweepRunner)
      .run(IDEMPOTENCY_PURGE_SWEEP, new Date(Date.now() + 25 * 3_600_000));
    expect(purged).toBeGreaterThanOrEqual(1);
    await post({ n: 111 }, k).expect(201);
    expect(await notes(111)).toBe(2);
  });
});

import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { NotificationInput } from '../../src/core/notifications/notifier';
import { Notifier } from '../../src/core/notifications/notifier';
import { PushOutbox } from '../../src/core/push/push-outbox';
import {
  PUSH_LEASE_MS,
  PushProcessor,
} from '../../src/core/push/push-processor';
import type { PushResult } from '../../src/core/push/push-transport';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers, type Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  drainPush,
  FakePushTransport,
  pushToken,
  registerPush,
} from '../setup/push';

const input = (n: number): NotificationInput => ({
  kind: 'ticket.message',
  params: { ticketNumber: n },
  targetId: newId(),
});

/**
 * At most once (ADR 0041): a notification reaches a device through one
 * row, one claimant, and one send — with several app instances running,
 * and when a sender dies in the middle.
 */
describe('Push outbox — claim once, send at most once (ADR 0041)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let globalDb: GlobalDbService;
  let c: Compound;
  const fake = new FakePushTransport();

  beforeAll(async () => {
    h = await createHttpHarness({ push: fake });
    x = communityHelpers(h);
    globalDb = h.moduleRef.get(GlobalDbService);
    c = await x.compound('Push Claim Court');
  }, 120_000);

  afterAll(() => h.close());

  beforeEach(async () => {
    fake.reset();
    await globalDb.pushDelivery.deleteMany({});
  });

  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    const push = pushToken();
    await registerPush(h, token, { token: push }).expect(204);
    return { ...p, token, push };
  }

  const notify = (accountIds: string[], n: number) =>
    x.asManager(c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          h.moduleRef.get(Notifier).notify(tx, accountIds, input(n)),
        ),
    );

  const deliveries = (accountId: string) =>
    globalDb.pushDelivery.findMany({
      where: { device: { accountId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  /** Another app instance: its own processor over the same database. */
  const instance = () =>
    new PushProcessor(
      h.moduleRef.get(ConfigService),
      globalDb,
      h.moduleRef.get(TenantTx),
      h.moduleRef.get(ClsService),
      h.moduleRef.get(SweepRunner),
      fake,
    );

  it('three instances running at once send every notification exactly once', async () => {
    const p = await someone();
    const q = await someone();
    const COUNT = 30;
    for (let n = 1; n <= COUNT; n++) await notify([p.id, q.id], n);
    expect(await globalDb.pushDelivery.count()).toBe(COUNT * 2);

    const workers = [h.moduleRef.get(PushProcessor), instance(), instance()];
    for (let round = 0; round < 10; round++) {
      const runs = await Promise.all(workers.map((w) => w.processDue()));
      if (runs.every((r) => r.sent === 0)) break;
    }

    expect(fake.sent).toHaveLength(COUNT * 2);
    const seen = fake.sent.map((m) => `${m.token}|${m.data.notificationId}`);
    expect(new Set(seen).size).toBe(COUNT * 2);
    for (const who of [p, q]) {
      const rows = await deliveries(who.id);
      expect(rows).toHaveLength(COUNT);
      expect(rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(
        true,
      );
    }
  });

  it('a claim is exclusive: a row one instance holds is not claimed by another', async () => {
    const p = await someone();
    for (let n = 1; n <= 5; n++) await notify([p.id], n);
    const now = new Date();
    const [first, second] = await Promise.all([
      globalDb.claimPush(20, PUSH_LEASE_MS, now),
      globalDb.claimPush(20, PUSH_LEASE_MS, now),
    ]);
    const ids = [...first, ...second].map((d) => d.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    // Held: nothing is due for anyone else.
    expect(await globalDb.claimPush(20, PUSH_LEASE_MS, now)).toEqual([]);
  });

  it('a sender that died mid-send: the delivery is retired at lease expiry and never sent again', async () => {
    const p = await someone();
    await notify([p.id], 1);
    const t0 = new Date();
    // The instance claimed it and died: the request may or may not have left.
    const [claimed] = await globalDb.claimPush(1, PUSH_LEASE_MS, t0);
    expect(claimed).toMatchObject({ attempts: 1 });

    // While the lease runs nobody else touches it.
    expect(
      await drainPush(h, new Date(t0.getTime() + PUSH_LEASE_MS - 1)),
    ).toMatchObject({ sent: 0, dead: 0 });
    expect(
      await drainPush(h, new Date(t0.getTime() + PUSH_LEASE_MS + 1)),
    ).toMatchObject({ sent: 0, dead: 1 });
    expect(await deliveries(p.id)).toMatchObject([
      {
        status: 'dead',
        lastErrorCode: 'LEASE_EXPIRED',
        attempts: 1,
        lockedUntil: null,
      },
    ]);
    await drainPush(h, new Date(t0.getTime() + 86_400_000));
    expect(fake.sent).toEqual([]);
  });

  it('an instance that lost its lease while it prepared does not send', async () => {
    const p = await someone();
    await notify([p.id], 1);
    const slow = instance();
    // Between the claim and the send, the lease is taken away (as if this
    // run had stalled past it and the row had been retired).
    const claim = globalDb.claimPush.bind(globalDb);
    const spy = jest
      .spyOn(globalDb, 'claimPush')
      .mockImplementation(async (...args) => {
        const rows = await claim(...args);
        await globalDb.retireExpiredPush(
          new Date(Date.now() + PUSH_LEASE_MS * 2),
        );
        return rows;
      });
    try {
      expect(await slow.processDue()).toMatchObject({ sent: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(fake.sent).toEqual([]);
    expect(await deliveries(p.id)).toMatchObject([
      { status: 'dead', lastErrorCode: 'LEASE_EXPIRED' },
    ]);
  });

  it('a slow send does not let a second instance send the same message', async () => {
    const p = await someone();
    await notify([p.id], 1);
    let release!: (r: PushResult) => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => (started = resolve));
    fake.nextRun(
      () =>
        new Promise<PushResult>((resolve) => {
          release = resolve;
          started();
        }),
    );
    const first = h.moduleRef.get(PushProcessor).processDue();
    await sending;
    // The first send is in flight: a second instance finds nothing due.
    expect(await instance().processDue()).toEqual({
      sent: 0,
      retried: 0,
      dead: 0,
      dropped: 0,
    });
    release({ ok: true });
    expect(await first).toMatchObject({ sent: 1 });
    expect(fake.sent).toHaveLength(1);
    expect(await deliveries(p.id)).toMatchObject([
      { status: 'sent', attempts: 1 },
    ]);
  });

  it('queueing the same notification twice for a device is refused by the database', async () => {
    const p = await someone();
    const notificationId = newId();
    const enqueue = () =>
      x.asManager(c, () =>
        h.moduleRef
          .get(TenantTx)
          .withTenantTx((tx) =>
            h.moduleRef
              .get(PushOutbox)
              .enqueue(
                tx,
                c.tenantId,
                [{ id: notificationId, accountId: p.id }],
                'ticket.message',
              ),
          ),
      );
    expect(await enqueue()).toBe(1);
    await expect(enqueue()).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await globalDb.pushDelivery.count({ where: { notificationId } }),
    ).toBe(1);
  });
});

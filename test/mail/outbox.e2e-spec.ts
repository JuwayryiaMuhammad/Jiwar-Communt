import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '../../src/core/common/uuid';
import type { Env } from '../../src/core/config/env.schema';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { EmailTemplates } from '../../src/core/mail/email-templates';
import { Mailer } from '../../src/core/mail/mailer';
import { Outbox } from '../../src/core/mail/outbox';
import {
  BACKOFF_MS,
  LEASE_MS,
  OutboxProcessor,
} from '../../src/core/mail/outbox-processor';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { HouseholdsService } from '../../src/community/households/households.service';
import { InviteAcceptanceService } from '../../src/community/households/invite-acceptance.service';
import { communityHelpers } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { countEmails, waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';

const MINUTE = 60_000;
const TEMPLATE = 'household.member_removed';

/** The email outbox: transactional, retried, at least once (ADR 0019). */
describe('Email outbox', () => {
  let h: HttpHarness;
  let globalDb: GlobalDbService;
  let outbox: Outbox;
  let processor: OutboxProcessor;
  let mailer: Mailer;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    globalDb = h.moduleRef.get(GlobalDbService);
    outbox = h.moduleRef.get(Outbox);
    processor = h.moduleRef.get(OutboxProcessor);
    mailer = h.moduleRef.get(Mailer);
    // Messages other suites left behind are delivered first, so each test
    // below only sees its own.
    await drainOutbox(h);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => h.close());

  const params = { compoundName: 'Outbox Court', unitCode: 'O-1', reason: 'r' };

  /** A committed message to a fresh address; returns its id and recipient. */
  async function queued(label = 'outbox') {
    const recipient = uniqueEmail(label);
    const id = await globalDb.transaction((tx) =>
      outbox.enqueue(tx, {
        templateKey: TEMPLATE,
        locale: 'en',
        recipient,
        params,
      }),
    );
    return { id, recipient };
  }

  const row = (id: string) =>
    globalDb.outboxMessage.findUniqueOrThrow({ where: { id } });

  const smtpDown = () =>
    jest.spyOn(mailer, 'send').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNECTION',
      }),
    );

  // --------------------------------------------------------------------------
  it('enqueue belongs to the action: rolled back together, both ways', async () => {
    const recipient = uniqueEmail('rollback');
    await expect(
      globalDb.transaction(async (tx) => {
        await outbox.enqueue(tx, {
          templateKey: TEMPLATE,
          locale: 'en',
          recipient,
          params,
        });
        throw new Error('the action failed');
      }),
    ).rejects.toThrow('the action failed');
    expect(await globalDb.outboxMessage.count({ where: { recipient } })).toBe(
      0,
    );

    // The message cannot be written → the action (a removal) rolls back.
    const x = communityHelpers(h);
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const kid = await x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).addMinor(u.id, {
        fullName: 'Kid',
        relation: 'child',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(5)),
      }),
    );
    const member = await x.joinFamily(c, u.id, primary);
    jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      x.as(c, { id: primary.id, type: 'resident' }, () =>
        h.moduleRef
          .get(HouseholdsService)
          .removeMember(member.memberId, { code: 'other', text: 'x' }),
      ),
    ).rejects.toThrow('outbox unavailable');
    const still = await x.asManager(c, () =>
      x.prisma.tenant.householdMember.findUniqueOrThrow({
        where: { id: member.memberId },
      }),
    );
    expect(still.status).toBe('active');
    expect(kid.status).toBe('active');
  });

  it('an unknown template is refused at enqueue, failing the action', async () => {
    await expect(
      globalDb.transaction((tx) =>
        outbox.enqueue(tx, {
          templateKey: 'no.such.template',
          locale: 'en',
          recipient: uniqueEmail('x'),
          params: {},
        }),
      ),
    ).rejects.toThrow('Unknown email template');
  });

  // --------------------------------------------------------------------------
  it('with SMTP down it retries on the backoff schedule, and sends once SMTP is back', async () => {
    const { id, recipient } = await queued('retry');
    const t0 = new Date();
    const send = smtpDown();

    await processor.processDue(t0);
    expect(await row(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'ECONNECTION',
      lockedUntil: null,
      nextAttemptAt: new Date(t0.getTime() + BACKOFF_MS[0]),
    });

    // Not due yet: nothing is tried.
    const calls = send.mock.calls.length;
    await processor.processDue(new Date(t0.getTime() + 30_000));
    expect(send.mock.calls.length).toBe(calls);

    const t1 = new Date(t0.getTime() + BACKOFF_MS[0]);
    await processor.processDue(t1);
    expect(await row(id)).toMatchObject({
      status: 'pending',
      attempts: 2,
      nextAttemptAt: new Date(t1.getTime() + BACKOFF_MS[1]),
    });

    send.mockRestore();
    const since = new Date();
    await processor.processDue(new Date(t1.getTime() + BACKOFF_MS[1]));
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 3 });
    const email = await waitForMessage(recipient, since);
    expect(email.Subject).toBe('You were removed from a household on Jiwar');
    expect(email.MessageID).toBe(`outbox-${id}@jiwar.local`);
  });

  it('the backoff runs 1m, 5m, 30m, 2h, 6h, then stays at 6h', () => {
    expect(BACKOFF_MS).toEqual([
      1 * MINUTE,
      5 * MINUTE,
      30 * MINUTE,
      120 * MINUTE,
      360 * MINUTE,
    ]);
  });

  it('after the last attempt the message is dead, logged by id and error code only', async () => {
    const { id, recipient } = await queued('dead');
    await globalDb.outboxMessage.update({
      where: { id },
      data: { attempts: 7 }, // OUTBOX_MAX_ATTEMPTS defaults to 8
    });
    smtpDown();
    const errors = jest.spyOn(Logger.prototype, 'error');
    await processor.processDue(new Date());
    expect(await row(id)).toMatchObject({
      status: 'dead',
      attempts: 8,
      lastErrorCode: 'ECONNECTION',
      lockedUntil: null,
    });
    const logged = errors.mock.calls.map(([m]) => String(m));
    expect(logged).toContain(`outbox message ${id} is dead (ECONNECTION)`);
    for (const m of logged) expect(m).not.toContain(recipient);
  });

  it('two processors at once send each message exactly once (SKIP LOCKED)', async () => {
    const messages = await Promise.all(
      // More than one batch (20), so both processors get work.
      Array.from({ length: 30 }, () => queued('race')),
    );
    const sentIds: string[] = [];
    jest.spyOn(mailer, 'send').mockImplementation(async (_to, _email, opts) => {
      sentIds.push(opts?.messageId ?? '');
      await new Promise((r) => setTimeout(r, 30)); // overlap the two runs
    });
    const other = new OutboxProcessor(
      h.moduleRef.get(ConfigService),
      globalDb,
      h.moduleRef.get(EmailTemplates),
      mailer,
    );
    const [a, b] = await Promise.all([
      processor.processDue(),
      other.processDue(),
    ]);
    expect(a.sent + b.sent).toBe(30);
    expect(sentIds).toHaveLength(30);
    expect(new Set(sentIds).size).toBe(30); // never the same message twice
    for (const m of messages) {
      expect((await row(m.id)).status).toBe('sent');
    }
  });

  it('a message whose lease expired (its sender died) is claimed again', async () => {
    const recipient = uniqueEmail('lease');
    const id = newId();
    await globalDb.outboxMessage.create({
      data: {
        id,
        channel: 'email',
        templateKey: TEMPLATE,
        locale: 'ar',
        recipient,
        params,
        status: 'processing',
        lockedUntil: new Date(Date.now() - 1000),
      },
    });
    // A live lease is left alone.
    const live = await queued('live-lease');
    await globalDb.outboxMessage.update({
      where: { id: live.id },
      data: {
        status: 'processing',
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });
    const since = new Date();
    await processor.processDue();
    // The unfinished attempt counts: it is recorded as one.
    expect(await row(id)).toMatchObject({
      status: 'sent',
      attempts: 1,
      lastErrorCode: 'LEASE_EXPIRED',
    });
    expect((await row(live.id)).status).toBe('processing');
    expect((await waitForMessage(recipient, since)).Subject).toBe(
      'تمت إزالتك من أسرة وحدة على جوار',
    );
  });

  it('a message that crashes its sender every time dies at its claim, and the queue moves on', async () => {
    const maxAttempts = h.moduleRef
      .get<ConfigService<Env, true>>(ConfigService)
      .get('OUTBOX_MAX_ATTEMPTS', { infer: true });
    const poison = await queued('poison');
    await globalDb.outboxMessage.update({
      where: { id: poison.id },
      data: { nextAttemptAt: new Date('2000-01-01T00:00:00Z') }, // first in line
    });
    const next = await queued('after-poison');

    // Sending the poison message "kills the process": the send never
    // returns, and the run is abandoned with its lease still held.
    let crashed: () => void = () => undefined;
    let poisonSends = 0;
    const send = mailer.send.bind(mailer);
    jest.spyOn(mailer, 'send').mockImplementation((to, email, opts) => {
      if (to !== poison.recipient) return send(to, email, opts);
      poisonSends += 1;
      crashed();
      return new Promise<never>(() => undefined);
    });

    const since = new Date();
    const t0 = Date.now();
    const step = LEASE_MS + 1000; // each restart finds the lease expired
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const died = new Promise<void>((resolve) => (crashed = resolve));
      void processor.processDue(new Date(t0 + (attempt - 1) * step));
      await died;
      // Counted by the claim, although the attempt never finished.
      expect(await row(poison.id)).toMatchObject({
        status: 'processing',
        attempts: attempt,
      });
    }
    // The first crash took the next message down with it (same claim);
    // it was reclaimed alone and sent while the poison kept crashing.
    expect(await row(next.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await waitForMessage(next.recipient, since)).Subject).toBe(
      'You were removed from a household on Jiwar',
    );

    const errors = jest.spyOn(Logger.prototype, 'error');
    const run = await processor.processDue(new Date(t0 + maxAttempts * step));
    expect(run.dead).toBeGreaterThanOrEqual(1);
    expect(await row(poison.id)).toMatchObject({
      status: 'dead',
      attempts: maxAttempts,
      lastErrorCode: 'LEASE_EXPIRED',
      lockedUntil: null,
    });
    expect(poisonSends).toBe(maxAttempts); // the dead claim sent nothing
    const logged = errors.mock.calls.map(([m]) => String(m));
    expect(logged).toContain(
      `outbox message ${poison.id} is dead (LEASE_EXPIRED)`,
    );
    for (const m of logged) expect(m).not.toContain(poison.recipient);

    // Never claimed again.
    await processor.processDue(new Date(t0 + (maxAttempts + 10) * step));
    expect(poisonSends).toBe(maxAttempts);
    expect((await row(poison.id)).status).toBe('dead');
  });

  it('one failing message never stops the run: a send error or anything else', async () => {
    const broken = await queued('broken');
    const refused = await queued('refused');
    const fine = await queued('fine');

    const send = mailer.send.bind(mailer);
    jest
      .spyOn(mailer, 'send')
      .mockImplementation((to, email, opts) =>
        to === refused.recipient
          ? Promise.reject(
              Object.assign(new Error('rejected'), { responseCode: 550 }),
            )
          : send(to, email, opts),
      );
    // A failure outside the send (e.g. the database while marking it).
    type Deliver = (message: { id: string }, now: Date) => Promise<string>;
    const target = processor as unknown as { deliver: Deliver };
    const deliver = target.deliver.bind(processor);
    jest
      .spyOn(target, 'deliver')
      .mockImplementation((message, now) =>
        message.id === broken.id
          ? Promise.reject(new TypeError('boom'))
          : deliver(message, now),
      );
    const errors = jest.spyOn(Logger.prototype, 'error');

    const since = new Date();
    const run = await processor.processDue();
    expect(run).toEqual({ sent: 1, retried: 2, dead: 0 });
    // Left under its lease; claimed again (as an attempt) once it expires.
    expect(await row(broken.id)).toMatchObject({
      status: 'processing',
      attempts: 1,
    });
    expect(await row(refused.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'SMTP_550',
    });
    expect(await row(fine.id)).toMatchObject({ status: 'sent', attempts: 1 });
    await waitForMessage(fine.recipient, since);
    const logged = errors.mock.calls.map(([m]) => String(m));
    expect(logged).toContain(`outbox message ${broken.id} failed (TypeError)`);
    for (const m of logged) expect(m).not.toContain(broken.recipient);

    const later = new Date(Date.now() + LEASE_MS + 1000);
    jest.restoreAllMocks();
    await processor.processDue(later);
    expect(await row(broken.id)).toMatchObject({
      status: 'sent',
      attempts: 2,
      lastErrorCode: 'LEASE_EXPIRED',
    });
  });

  it('retention deletes old sent rows and strips old dead ones, keeping the evidence', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 31 * 24 * 60 * MINUTE);
    const base = {
      channel: 'email' as const,
      templateKey: TEMPLATE,
      locale: 'en' as const,
      params,
    };
    const ids = {
      oldSent: newId(),
      newSent: newId(),
      oldDead: newId(),
      newDead: newId(),
    };
    await globalDb.outboxMessage.createMany({
      data: [
        {
          ...base,
          id: ids.oldSent,
          recipient: uniqueEmail('r'),
          status: 'sent',
          sentAt: old,
          createdAt: old,
        },
        {
          ...base,
          id: ids.newSent,
          recipient: uniqueEmail('r'),
          status: 'sent',
          sentAt: now,
        },
        {
          ...base,
          id: ids.oldDead,
          recipient: uniqueEmail('r'),
          status: 'dead',
          attempts: 8,
          lastErrorCode: 'ECONNECTION',
          createdAt: old,
          tenantId: null,
        },
        {
          ...base,
          id: ids.newDead,
          recipient: uniqueEmail('r'),
          status: 'dead',
          attempts: 8,
        },
      ],
    });
    await processor.purge(now);

    expect(
      await globalDb.outboxMessage.findUnique({ where: { id: ids.oldSent } }),
    ).toBeNull();
    expect(await row(ids.newSent)).toMatchObject({ status: 'sent' });
    expect(await row(ids.oldDead)).toMatchObject({
      status: 'dead',
      recipient: null,
      params: null,
      templateKey: TEMPLATE,
      attempts: 8,
      lastErrorCode: 'ECONNECTION',
      strippedAt: now,
    });
    expect((await row(ids.newDead)).recipient).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  it('business flows queue their emails instead of sending them', async () => {
    const x = communityHelpers(h);
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const member = await x.joinFamily(c, u.id, primary);
    const since = new Date();
    await x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(HouseholdsService)
        .removeMember(member.memberId, { code: 'other', text: 'left' }),
    );
    const pending = await globalDb.outboxMessage.findMany({
      where: { recipient: member.email },
    });
    expect(pending.map((m) => [m.templateKey, m.status])).toEqual([
      [TEMPLATE, 'pending'],
    ]);
    expect(pending[0].tenantId).toBe(c.tenantId);
    expect(await countEmails(member.email, since, 500)).toBe(0);

    await drainOutbox(h);
    expect((await waitForMessage(member.email, since)).Subject).toMatch(
      /removed|تمت إزالتك/,
    );
  });

  it('login and invite codes are still sent directly, not through the outbox', async () => {
    const tenant = await h.createTenant('Direct OTP');
    const email = uniqueEmail('direct');
    await h.createAccount(tenant.id, {
      type: 'resident',
      email,
      phone: uniquePhone(),
    });
    const since = new Date();
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier: email })
      .expect(202);
    expect(await waitForOtp(email, since)).toMatch(/^\d{6}$/);

    const x = communityHelpers(h);
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const invitee = uniqueEmail('invitee');
    const invite = await x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).createInvite(u.id, {
        fullName: 'Direct Invitee',
        phone: uniquePhone(),
        email: invitee,
        relation: 'sibling',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
      }),
    );
    await h.moduleRef
      .get(InviteAcceptanceService)
      .startAcceptance(invite.token, '10.3.0.1', 'en');
    expect(await waitForOtp(invitee, since)).toMatch(/^\d{6}$/);

    expect(
      await globalDb.outboxMessage.count({
        where: { recipient: { in: [email, invitee] } },
      }),
    ).toBe(0);
  });
});

describe('Email outbox poller', () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness();
  });

  afterAll(() => h.close());

  it('starts when enabled, delivers on its own, and stops cleanly on shutdown', async () => {
    // The app reads the environment once, at import; the processor gets its
    // own settings here.
    const real = h.moduleRef.get(ConfigService);
    const config = {
      get: (key: string): unknown =>
        key === 'OUTBOX_ENABLED'
          ? true
          : key === 'OUTBOX_POLL_MS'
            ? 50
            : real.get<unknown>(key),
    } as unknown as ConfigService<Env, true>;
    const globalDb = h.moduleRef.get(GlobalDbService);
    const processor = new OutboxProcessor(
      config,
      globalDb,
      h.moduleRef.get(EmailTemplates),
      h.moduleRef.get(Mailer),
    );
    processor.onApplicationBootstrap();
    try {
      expect(processor.polling).toBe(true);
      const recipient = uniqueEmail('poller');
      const id = await globalDb.transaction((tx) =>
        h.moduleRef.get(Outbox).enqueue(tx, {
          templateKey: TEMPLATE,
          locale: 'en',
          recipient,
          params: { compoundName: 'Poll', unitCode: 'P-1', reason: 'r' },
        }),
      );
      const deadline = Date.now() + 5000;
      let status = 'pending';
      while (status !== 'sent' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        status = (
          await globalDb.outboxMessage.findUniqueOrThrow({ where: { id } })
        ).status;
      }
      expect(status).toBe('sent');
    } finally {
      await processor.onApplicationShutdown();
    }
    expect(processor.polling).toBe(false);

    // Stopped means stopped: a new message stays pending.
    const idle = await globalDb.transaction((tx) =>
      h.moduleRef.get(Outbox).enqueue(tx, {
        templateKey: TEMPLATE,
        locale: 'en',
        recipient: uniqueEmail('idle'),
        params: { compoundName: 'Poll', unitCode: 'P-1', reason: 'r' },
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await globalDb.outboxMessage.findUniqueOrThrow({ where: { id: idle } }))
        .status,
    ).toBe('pending');
  });

  it('the app itself does not poll when OUTBOX_ENABLED=false (the test setting)', () => {
    expect(h.moduleRef.get(OutboxProcessor).polling).toBe(false);
  });
});

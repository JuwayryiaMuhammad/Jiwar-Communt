import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HouseholdsService } from '../../src/community/households/households.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { passBody } from '../api/routes/visitors';
import { communityHelpers } from '../setup/community';
import { buildExports } from '../setup/exports';
import { bornYearsAgo, nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { requestAndVerify } from '../setup/login';
import { waitForMessage } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';
import { required } from '../setup/test-env';

/**
 * Not an e2e suite (the name keeps it out of `test:e2e` and CI): the API the
 * public web pages' browser smoke runs against (apps/public/e2e). It boots
 * the app on the test database like any suite, listens on a port, seeds one
 * link of every kind, writes them to <WEB_SMOKE_DIR>/seed.json and serves
 * until <WEB_SMOKE_DIR>/stop appears.
 *
 *   WEB_SMOKE_DIR=… WEB_SMOKE_API_PORT=3190 pnpm exec jest \
 *     --config ./test/jest-e2e.json --runInBand \
 *     --testRegex 'web-smoke/serve\.web-smoke\.ts$'
 */
const DIR = required('WEB_SMOKE_DIR');
const PORT = Number(process.env.WEB_SMOKE_API_PORT ?? 3190);
const SERVE_MS = 20 * 60_000;

const VISITOR_LINK = /\/v#([A-Za-z0-9_-]{43})$/;
const ANDROID_APP = 'Jiwar/1.4.0 (Android 14; Pixel 8)';
const FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const INSTALL = '0192a5f0-1c2b-7d3e-8f40-0000000000aa';

describe('Web smoke: the API behind apps/public', () => {
  let h: HttpHarness;

  afterAll(() => h?.close());

  it(
    'seeds one link of every kind and serves until told to stop',
    async () => {
      h = await createHttpHarness({ listen: false });
      const x = communityHelpers(h);
      const c = await x.compound('Web Smoke Court');
      const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
      const managerToken = await h.tokenFor({
        sub: c.managerId,
        tid: c.tenantId,
        typ: 'manager',
      });

      // --- Visitor passes (ADR 0030): the host's link, as issued.
      const home = await x.unit(c, `W-${uniqueSuffix()}`);
      const owner = await x.resident(c, [home.id]);
      const ownerToken = await h.tokenFor({
        sub: owner.id,
        tid: c.tenantId,
        typ: 'resident',
      });
      const pass = async (over: object = {}) => {
        const res = await h
          .http()
          .post(`${API}/units/${home.id}/visitor-passes`)
          .set(bearer(ownerToken))
          .send(passBody(over))
          .expect(201);
        const body = res.body as { id: string; link: string };
        const token = VISITOR_LINK.exec(body.link)?.[1];
        if (!token) throw new Error(`not a visitor link: ${body.link}`);
        return { id: body.id, token };
      };
      // Expired first: the sweep runs with a clock two hours ahead.
      const expired = await pass({
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await h.moduleRef
        .get(SweepRunner)
        .run(VISITOR_DATA_SWEEP, new Date(Date.now() + 2 * 3_600_000));
      const active = await pass();
      const wrongRecipient = await pass();
      const cancelled = await pass();
      await h
        .http()
        .post(`${API}/visitor-passes/${cancelled.id}/cancel`)
        .set(bearer(ownerToken))
        .send({ reasonCode: 'plans_changed' })
        .expect(204);

      // A tenant beside an owner: freezing or exporting them moves nothing else.
      const someone = async () => {
        const unit = await x.unit(c);
        await x.resident(c, [unit.id]);
        return x.resident(c, [unit.id], 'tenant');
      };

      // --- "Not me" (ADR 0036): a second device raises the alert email.
      const login = async (
        p: { id: string; email: string },
        device: { ua: string; installId?: string },
      ) => {
        const verified = await requestAndVerify(h, p.email, p.email);
        let req = h
          .http()
          .post(`${API}/auth/select-account`)
          .set('User-Agent', device.ua);
        if (device.installId)
          req = req.set('X-Jiwar-Install-Id', device.installId);
        await req
          .send({ loginTicket: verified.loginTicket, accountId: p.id })
          .expect(200);
      };
      const alerted = await someone();
      await login(alerted, { ua: ANDROID_APP, installId: INSTALL });
      const alertSince = new Date();
      await login(alerted, { ua: FIREFOX_LINUX });
      await drainOutbox(h);
      const notMe = /\/a\/not-me#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
        (await waitForMessage(alerted.email, alertSince)).Text,
      )?.[1];
      if (!notMe) throw new Error('no not-me link in the alert email');

      // --- Assisted export (ADR 0036): the link goes to the account's email.
      const exported = await someone();
      await h
        .http()
        .post(`${API}/accounts/${exported.id}/data-exports`)
        .set(bearer(managerToken))
        .send({ reasonCode: 'in_person' })
        .expect(201);
      const exportSince = new Date();
      await buildExports(h);
      await drainOutbox(h);
      const exportToken = /\/a\/export#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
        (await waitForMessage(exported.email, exportSince)).Text,
      )?.[1];
      if (!exportToken) throw new Error('no export link in the email');

      // --- A household invite and a registration link: bare tokens.
      const invitedEmail = uniqueEmail('invited');
      const invite = await x.as(c, { id: owner.id, type: 'resident' }, () =>
        h.moduleRef.get(HouseholdsService).createInvite(home.id, {
          fullName: 'Invited Sister',
          phone: uniquePhone(),
          email: invitedEmail,
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(25)),
          relation: 'sibling',
        }),
      );
      const registration = await x.asManager(c, () =>
        h.moduleRef.get(RegistrationService).createLink(),
      );

      await h.app.listen(PORT, '127.0.0.1');
      mkdirSync(DIR, { recursive: true });
      writeFileSync(
        join(DIR, 'seed.json'),
        JSON.stringify(
          {
            api: `http://127.0.0.1:${PORT}`,
            mailpit: required('MAILPIT_API_URL'),
            visitor: {
              active: active.token,
              wrongRecipient: wrongRecipient.token,
              expired: expired.token,
              cancelled: cancelled.token,
              unitCode: home.code,
            },
            notMe: { token: notMe },
            export: { token: exportToken, email: exported.email },
            invite: { token: invite.token, email: invitedEmail },
            registration: {
              token: registration.token,
              unitCode: home.code,
              email: uniqueEmail('registrant'),
              phone: uniquePhone(),
              nationalId: nationalIdFor(),
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      const stop = join(DIR, 'stop');
      const deadline = Date.now() + SERVE_MS;
      while (!existsSync(stop) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(stop)).toBe(true);
    },
    SERVE_MS + 5 * 60_000,
  );
});

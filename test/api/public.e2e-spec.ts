import { HouseholdsService } from '../../src/community/households/households.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { bornYearsAgo, nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { keyPaths } from './keys';
import { call } from './request';
import { buildWorld, type World } from './world';

describe('API v0 — public', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  it('accepts a household invite', async () => {
    const email = uniqueEmail('invitee');
    const invite = await w.helpers.as(
      w.a,
      { id: w.a.ids.owner, type: 'resident' },
      () =>
        h.moduleRef.get(HouseholdsService).createInvite(w.a.homeUnitId, {
          fullName: 'Invited Sister',
          phone: uniquePhone(),
          email,
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(25)),
          relation: 'sibling',
        }),
    );
    const since = new Date();
    const started = await call(w, 'POST', '/invites/accept/start', {
      body: { token: invite.token },
    }).expect(202);
    expect(started.body).toEqual({ code: 'INVITE_CODE_REQUESTED' });

    const code = await waitForOtp(email, since);
    const wrong = await call(w, 'POST', '/invites/accept/complete', {
      body: {
        token: invite.token,
        code: code === '000000' ? '111111' : '000000',
      },
    });
    expect({
      status: wrong.status,
      code: (wrong.body as { code: string }).code,
    }).toEqual({ status: 401, code: 'OTP_INVALID' });

    const done = await call(w, 'POST', '/invites/accept/complete', {
      body: { token: invite.token, code },
    }).expect(200);
    expect(keyPaths(done.body)).toEqual(['code', 'membershipStatus']);
    expect(done.body).toEqual({
      code: 'INVITE_ACCEPTED',
      membershipStatus: 'active',
    });
  });

  it('takes a self-registration request', async () => {
    const registrations = h.moduleRef.get(RegistrationService);
    const { token } = await w.helpers.asManager(w.a, () =>
      registrations.createLink(),
    );
    const email = uniqueEmail('registrant');
    const request = {
      linkToken: token,
      fullName: `Registrant ${uniqueSuffix()}`,
      unitCode: 'NO-SUCH-UNIT',
      phone: '01012345678',
      email,
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(),
      occupancyType: 'owner',
      areaSqm: 120,
    };
    const since = new Date();
    const started = await call(w, 'POST', '/registrations/start', {
      body: request,
    }).expect(202);
    expect(started.body).toEqual({ code: 'REGISTRATION_CODE_SENT' });

    const code = await waitForOtp(email, since);
    const done = await call(w, 'POST', '/registrations/complete', {
      body: { ...request, code },
    }).expect(202);
    expect(done.body).toEqual({ code: 'REGISTRATION_RECEIVED' });

    const pending = await w.helpers.asManager(w.a, () =>
      registrations.pending(),
    );
    expect(pending.map((p) => p.email)).toContain(email);
  });

  it('answers a shape error with the service field codes, all at once', async () => {
    const res = await call(w, 'POST', '/registrations/start', {
      body: { linkToken: 'x', occupancyType: 'guest' },
    }).expect(400);
    expect(
      (res.body as { fields: { field: string }[] }).fields.map((f) => f.field),
    ).toEqual(
      expect.arrayContaining([
        'fullName',
        'unitCode',
        'phone',
        'email',
        'occupancyType',
      ]),
    );
  });
});

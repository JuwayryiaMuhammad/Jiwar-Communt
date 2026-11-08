import { AccountsService } from '../../src/core/accounts/accounts.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { CERTIFICATE_SWEEP } from '../../src/maintenance/certificates/certificates.service';
import { auditReaders } from '../setup/audit';
import { day } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { engagementHelpers } from '../setup/engagement';
import { eraseNow } from '../setup/erasure';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

interface Certificate {
  id: string;
  holder: { id: string };
  kind: string;
  title: string;
  expiresOn: string;
  state: string;
  daysLeft: number;
  hasFile: boolean;
  fileUrl: string | null;
  removedAt: string | null;
}

const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

/**
 * ADR 0090: a staff member's certificate, with the day it expires and its
 * paper, kept by the field team. Warn only: its holder and the field team
 * are told 30 days ahead and on the day, once each; it blocks nothing, and
 * it shows in the compliance calendar.
 */
describe('Staff certificates', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let audit: ReturnType<typeof auditReaders>;
  const runSweep = () =>
    h.moduleRef.get(SweepRunner).run(CERTIFICATE_SWEEP, new Date());
  const told = async (accountId: string, targetId: string) =>
    (await engagementHelpers(h).notifications(s.c, accountId))
      .filter((n) => n.targetId === targetId)
      .map((n) => n.kind);

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(2);
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  const add = (body: object, as: Who = s.supervisor) =>
    d.http('post', '/staff/field-team/certificates', as.token, {
      accountId: s.techs[0].id,
      kind: 'electrical',
      title: 'Low-voltage licence',
      issuer: 'The Syndicate',
      reference: 'EL-55-120',
      expiresOn: day(200),
      ...body,
    });

  it('added for an active staff member, with its paper; listed without its link, read with it; the holder reads theirs', async () => {
    const paper = await fileHelpers(h).ready(
      s.supervisor.token,
      'staff_certificate',
      'application/pdf',
    );
    const made = (await add({ fileId: paper }).expect(201)).body as Certificate;
    expect(made).toMatchObject({
      holder: { id: s.techs[0].id },
      kind: 'electrical',
      state: 'valid',
      hasFile: true,
    });
    expect(made.fileUrl).toEqual(expect.any(String));
    expect(fields(await add({ accountId: s.owner.id }))).toEqual([
      { field: 'accountId', code: 'CERTIFICATE_HOLDER_NOT_ELIGIBLE' },
    ]);
    expect(
      fields(await add({ issuedOn: day(300), expiresOn: day(200) })),
    ).toEqual([{ field: 'expiresOn', code: 'ENDS_BEFORE_START' }]);
    const list = (
      await d
        .http(
          'get',
          `/staff/field-team/certificates?accountId=${s.techs[0].id}`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as { data: Certificate[] };
    expect(list.data.map((c) => [c.id, c.fileUrl])).toEqual([[made.id, null]]);
    const one = (
      await d
        .http(
          'get',
          `/staff/field-team/certificates/${made.id}`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as Certificate;
    expect(one.fileUrl).toEqual(expect.any(String));
    const mine = (
      await d
        .http('get', '/staff/my-certificates', s.techs[0].token)
        .expect(200)
    ).body as { data: Certificate[] };
    expect(mine.data.map((c) => c.id)).toEqual([made.id]);
    expect(
      (await d.http('get', '/staff/my-certificates', s.owner.token)).status,
    ).toBe(403);
    expect(
      (await d.http('get', '/staff/field-team/certificates', s.techs[0].token))
        .status,
    ).toBe(403);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'staff_certificate.added',
          targetId: made.id,
        })
      )[0],
    ).toMatchObject({
      actorId: s.supervisor.id,
      metadata: { holderId: s.techs[0].id, kind: 'electrical', file: true },
    });
    expect(
      JSON.stringify(await audit.tenant(s.c.tenantId, { targetId: made.id })),
    ).not.toContain('EL-55-120');
  });

  it('warned once 30 days ahead and once on the day, the holder and the field team; a renewal warns again; nothing is blocked', async () => {
    const soon = (await add({ expiresOn: day(10) }).expect(201))
      .body as Certificate;
    expect(soon).toMatchObject({ state: 'expiring', daysLeft: 10 });
    const today = (
      await add({ accountId: s.techs[1].id, expiresOn: day(0) }).expect(201)
    ).body as Certificate;
    await runSweep();
    await runSweep();
    for (const who of [s.techs[0].id, s.supervisor.id, s.c.managerId])
      expect(await told(who, soon.id)).toEqual(['staff_certificate.expiring']);
    expect(await told(s.techs[1].id, today.id)).toEqual([
      'staff_certificate.expires_today',
    ]);
    // Renewed: no notice until the new expiry comes within the 30 days.
    await d
      .http(
        'patch',
        `/staff/field-team/certificates/${soon.id}`,
        s.supervisor.token,
        { expiresOn: day(20) },
      )
      .expect(200);
    await runSweep();
    expect(await told(s.techs[0].id, soon.id)).toEqual([
      'staff_certificate.expiring',
      'staff_certificate.expiring',
    ]);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'staff_certificate.changed',
          targetId: soon.id,
        })
      )[0],
    ).toMatchObject({
      metadata: { expiresOn: { from: day(10), to: day(20) } },
    });
    // An expired one blocks no assignment and no work.
    const expired = (
      await add({ accountId: s.techs[1].id, expiresOn: day(-3) }).expect(201)
    ).body as Certificate;
    expect(expired.state).toBe('expired');
    const ticket = await d.openTicket(s);
    await d
      .http(
        'post',
        `/maintenance/tickets/${ticket}/assign`,
        s.supervisor.token,
        { technicianId: s.techs[1].id },
      )
      .expect(204);
    await d
      .http('post', `/technician/tickets/${ticket}/start`, s.techs[1].token)
      .expect(204);
  });

  it('in the compliance calendar, with its holder; removed, it leaves it and its paper goes', async () => {
    const paper = await fileHelpers(h).ready(
      s.supervisor.token,
      'staff_certificate',
    );
    const cert = (
      await add({
        expiresOn: day(40),
        title: 'Gas fitter',
        fileId: paper,
      }).expect(201)
    ).body as Certificate;
    const calendar = async () =>
      (
        (
          await d
            .http(
              'get',
              `/staff/compliance/calendar?from=${day(39)}&to=${day(41)}`,
              s.manager.token,
            )
            .expect(200)
        ).body as {
          entries: { source: string; id: string; holderId: string | null }[];
        }
      ).entries.filter((e) => e.source === 'staff_certificate');
    expect(await calendar()).toEqual([
      expect.objectContaining({
        id: cert.id,
        holderId: s.techs[0].id,
        title: 'Gas fitter',
        state: 'valid',
      }),
    ]);
    await d
      .http(
        'delete',
        `/staff/field-team/certificates/${cert.id}`,
        s.supervisor.token,
      )
      .expect(204);
    expect(await calendar()).toEqual([]);
    expect(
      (
        await d.http(
          'patch',
          `/staff/field-team/certificates/${cert.id}`,
          s.supervisor.token,
          { title: 'Again' },
        )
      ).body,
    ).toMatchObject({ code: 'STAFF_CERTIFICATE_NOT_FOUND' });
    const file = await d.inTenant(s.c, (tx) =>
      tx.storedFile.findUnique({ where: { id: paper } }),
    );
    expect(file === null || file.deletedAt !== null).toBe(true);
  });

  it('a deactivated holder is told nothing; an erased one’s certificates go', async () => {
    const holder = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    const cert = (
      await add({ accountId: holder.id, expiresOn: day(5) }).expect(201)
    ).body as Certificate;
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(holder.id, { status: 'inactive' }),
    );
    await runSweep();
    expect(await told(s.supervisor.id, cert.id)).toEqual([]);
    await eraseNow(h, s.c, holder.id);
    expect(
      await d.inTenant(s.c, (tx) =>
        tx.staffCertificate.count({ where: { accountId: holder.id } }),
      ),
    ).toBe(0);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'staff_certificate.erased',
          targetId: holder.id,
        })
      )[0],
    ).toMatchObject({ metadata: { removed: 1 } });
  });
});

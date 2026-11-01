import { BOARD_REPORTS_SWEEP } from '../../src/governance/reports/board-reports.service';
import { auditReaders } from '../setup/audit';
import { boardMatterHelpers } from '../setup/board-matters';
import { month } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { governanceHelpers } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;

interface ReportBody {
  id: string;
  month: string;
  version: number;
  bySweep: boolean;
  contents: {
    month: string;
    governance: {
      requests: { raised: number; pending: number };
      meetings: { held: number; quorate: number };
      actions: { open: number };
    };
    sections: Record<string, unknown>;
  };
}

/**
 * ADR 0075: the monthly board report — the month before written once on a
 * month's first days and the sitting board told; any month up to the
 * current one drawn again as its next version; governance's figures beside
 * the overview's sections; a PDF with the compound's logo.
 */
describe('Governance — the monthly board report', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  const o = (i: number) => s.owners[i];

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    s = await b.setUp(4, 3);
  }, 180_000);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (f) => [f.field, f.code],
    );
  const draw = (m: string, as: { token: string } = o(0)) =>
    b.http('post', '/board/reports', as.token, { month: m });

  it('a month drawn on demand: governance’s figures and the overview’s sections; drawn again, its next version', async () => {
    const meeting = (
      (
        await b
          .http('post', '/board/meetings', o(0).token, {
            kind: 'regular',
            title: 'This month',
            scheduledAt: new Date(Date.now() - 2 * HOUR).toISOString(),
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    await b
      .http('post', `/board/meetings/${meeting}/hold`, o(0).token, {
        presentMemberIds: s.term.members.map((m) => m.id),
      })
      .expect(200);
    await b.raise(s.accountant);
    const first = (await draw(month(0)).expect(201)).body as ReportBody;
    expect(first).toMatchObject({
      month: month(0),
      version: 1,
      bySweep: false,
      contents: {
        month: month(0),
        governance: {
          requests: { raised: 1, pending: 1 },
          meetings: { held: 1, quorate: 1 },
        },
      },
    });
    expect(Object.keys(first.contents.sections).sort()).toEqual(
      expect.arrayContaining(['finance', 'security']),
    );
    const again = (await draw(month(0), s.manager).expect(201))
      .body as ReportBody;
    expect(again.version).toBe(2);
    const list = (await b.http('get', '/board/reports', o(1).token).expect(200))
      .body as { data: ReportBody[] };
    expect(list.data.map((r) => r.version)).toEqual([2, 1]);
    expect(
      (
        await auditReaders(h).tenant(s.c.tenantId, {
          action: 'board_report.generated',
          targetId: again.id,
        })
      )[0],
    ).toMatchObject({
      metadata: { month: month(0), version: 2, bySweep: false },
    });
  });

  it('a month ahead, or one not shaped YYYY-MM, is refused; an owner off the board reads nothing', async () => {
    expect(fields(await draw(month(1)).expect(400))).toEqual([
      ['month', 'DAY_OUT_OF_RANGE'],
    ]);
    expect(fields(await draw('2027-13').expect(400))).toEqual([
      ['month', 'INVALID_FORMAT'],
    ]);
    await b.http('get', '/board/reports', o(3).token).expect(403);
    await draw(month(0), o(3)).expect(403);
  });

  it('the sweep writes the month before once, and tells the sitting board', async () => {
    await b.sweep(BOARD_REPORTS_SWEEP);
    await b.sweep(BOARD_REPORTS_SWEEP);
    const rows = (await b.http('get', '/board/reports', o(0).token).expect(200))
      .body as { data: ReportBody[] };
    const swept = rows.data.filter((r) => r.month === month(-1));
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ version: 1, bySweep: true });
    for (const i of [0, 1, 2])
      expect(
        (await b.notifications(s.c, o(i).id, 'board_report.ready')).map(
          (n) => n.targetId,
        ),
      ).toEqual([swept[0].id]);
  });

  it('with the monthly report turned off, the sweep writes nothing', async () => {
    const other = await boardMatterHelpers(h).setUp(3, 3);
    await b
      .http('patch', '/staff/governance/rules', other.manager.token, {
        boardReportMonthly: false,
      })
      .expect(200);
    await b.sweep(BOARD_REPORTS_SWEEP);
    expect(
      (
        (await b.http('get', '/board/reports', other.manager.token).expect(200))
          .body as { data: unknown[] }
      ).data,
    ).toEqual([]);
  });

  it('a compound that never had a board gets nothing from the sweep; its manager draws a month on demand', async () => {
    const bare = await governanceHelpers(h).setUp(1);
    await b.sweep(BOARD_REPORTS_SWEEP);
    const list = () =>
      b.http('get', '/board/reports', bare.manager.token).expect(200);
    expect(((await list()).body as { data: unknown[] }).data).toEqual([]);
    const drawn = (await draw(month(-1), bare.manager).expect(201))
      .body as ReportBody;
    expect(drawn).toMatchObject({ version: 1, bySweep: false });
    expect(
      ((await list()).body as { data: ReportBody[] }).data.map((r) => r.id),
    ).toEqual([drawn.id]);
  });

  it('its PDF, headed by the compound’s logo once the manager sets one', async () => {
    const id = (
      (await b.http('get', '/board/reports', o(0).token).expect(200)).body as {
        data: ReportBody[];
      }
    ).data[0].id;
    const plain = await b
      .http('get', `/board/reports/${id}/pdf`, o(0).token)
      .expect(200);
    expect(plain.headers['content-type']).toContain('application/pdf');
    const logo = await fileHelpers(h).ready(
      s.manager.token,
      'compound_logo',
      'image/png',
    );
    // Another caller's upload, or a file of another purpose: refused.
    const wrong = await fileHelpers(h).ready(
      s.manager.token,
      'community_attachment',
      'image/png',
    );
    expect(
      fields(
        await b
          .http('patch', '/staff/governance/rules', s.manager.token, {
            reportLogoFileId: wrong,
          })
          .expect(400),
      ),
    ).toEqual([['reportLogoFileId', 'FILE_NOT_AVAILABLE']]);
    await b
      .http('patch', '/staff/governance/rules', s.manager.token, {
        reportLogoFileId: logo,
      })
      .expect(200);
    const branded = await b
      .http('get', `/board/reports/${id}/pdf`, o(0).token)
      .expect(200);
    expect((branded.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

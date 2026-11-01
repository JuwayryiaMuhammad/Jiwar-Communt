import { auditReaders } from '../setup/audit';
import { backdateInvoice, financeHelpers } from '../setup/finance';
import { gateHelpers } from '../setup/gate';
import { governanceHelpers, superuserSql, type Who } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface RulesBody {
  candidacyNoDues: boolean;
  candidacyNotStaff: boolean;
  reportLogoFileId: string | null;
  boardReportMonthly: boolean;
  updatedAt: string | null;
}

/**
 * ADR 0075: the compound's candidacy rules — off by default; with them on,
 * an owner whose units owe past their due date, or who also holds an
 * active staff or manager account (the same identity document), is
 * refused at nomination with the reason; everything else stays the
 * manager's, by disqualification (ADR 0051).
 */
describe('Governance — candidacy rules', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let f: ReturnType<typeof financeHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  const o = (i: number) => s.owners[i];

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    f = financeHelpers(h);
    s = await g.setUp(5);
    await g.appoint(s.manager, s.owners.slice(0, 3));
  }, 180_000);

  afterAll(() => h.close());

  const reason = (res: { body: unknown }) =>
    (res.body as { code: string; params?: { reason?: string } }).params?.reason;
  const rules = async (): Promise<RulesBody> =>
    (
      await g
        .http('get', '/staff/governance/rules', s.manager.token)
        .expect(200)
    ).body as RulesBody;
  const setRules = (body: Partial<RulesBody>) =>
    g
      .http('patch', '/staff/governance/rules', s.manager.token, body)
      .expect(200);
  const withdraw = (as: Who, id: string) =>
    g
      .http('post', `/governance/elections/${id}/candidacy/withdraw`, as.token)
      .expect(200);

  it('both rules are off until the manager sets them; a board member may not', async () => {
    expect(await rules()).toEqual({
      candidacyNoDues: false,
      candidacyNotStaff: false,
      reportLogoFileId: null,
      boardReportMonthly: true,
      updatedAt: null,
    });
    await g
      .http('patch', '/staff/governance/rules', o(0).token, {
        candidacyNoDues: true,
      })
      .expect(403);
  });

  it('an owner who is also on the staff stands while the rule is off, and is refused once it is on', async () => {
    const e = await g.election(s.manager);
    const guard = await gateHelpers(h).guard(s.c);
    // The same person: the owner's identity document on a staff account.
    await superuserSql(
      `UPDATE accounts SET id_document_type = o.id_document_type,
              id_document_number = o.id_document_number
         FROM accounts o WHERE accounts.id = $1 AND o.id = $2`,
      [guard.id, o(3).id],
    );
    await g.stand(o(3), e.id).expect(201);
    await withdraw(o(3), e.id);
    await setRules({ candidacyNotStaff: true });
    const refused = await g.stand(o(3), e.id).expect(409);
    expect(refused.body).toMatchObject({
      code: 'GOVERNANCE_CANDIDACY_NOT_ELIGIBLE',
    });
    expect(reason(refused)).toBe('staff');
    // Another owner, no staff account: stands.
    await g.stand(o(4), e.id).expect(201);
    // The staff account deactivated: the same person stands again.
    await superuserSql(
      `UPDATE accounts SET status = 'inactive' WHERE id = $1`,
      [guard.id],
    );
    await g.stand(o(3), e.id).expect(201);
    await setRules({ candidacyNotStaff: false });
  });

  it('an owner whose unit owes past its due date is refused once the rule is on; owed but not yet due, they stand', async () => {
    const e = await g.election(s.manager);
    await setRules({ candidacyNoDues: true });
    const { invoiceId } = await f.issue(s.manager, o(1).unitId);
    // Owed, due in ten days: not past due.
    await g.stand(o(1), e.id).expect(201);
    await withdraw(o(1), e.id);
    await backdateInvoice(invoiceId, 30);
    const refused = await g.stand(o(1), e.id).expect(409);
    expect(reason(refused)).toBe('dues_outstanding');
    expect(await rules()).toMatchObject({
      candidacyNoDues: true,
      candidacyNotStaff: false,
    });
    await setRules({ candidacyNoDues: false });
    await g.stand(o(1), e.id).expect(201);
  });

  it('every change is audited by value; setting the same values is no change', async () => {
    const rows = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'governance_rules.changed',
    });
    expect(rows.map((r) => r.changes)).toEqual([
      { candidacyNotStaff: { from: false, to: true } },
      { candidacyNotStaff: { from: true, to: false } },
      { candidacyNoDues: { from: false, to: true } },
      { candidacyNoDues: { from: true, to: false } },
    ]);
    await setRules({ candidacyNoDues: false });
    expect(
      await auditReaders(h).tenant(s.c.tenantId, {
        action: 'governance_rules.changed',
      }),
    ).toHaveLength(4);
  });
});

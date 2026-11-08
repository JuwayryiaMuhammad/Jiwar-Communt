import type { Response } from 'supertest';
import { boardMatterHelpers } from '../setup/board-matters';
import { day, daysLater, today } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { uniqueSuffix } from '../setup/fixtures';
import { superuserSql } from '../setup/governance';
import { activeBudget } from './no-store-board-matters';
import { call, type Method } from './request';
import type { World } from './world';

/** A setup call that must have done what it asked (awaited: a response). */
function done(res: Response, status = 201): Response {
  if (res.status !== status)
    throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/**
 * A real call for each no-store route of the contractor portal and tenders
 * (ADR 0088), in A: a tender's views carry documents' URLs, an invitation by
 * link and a new link carry the token shown once, the bid link's page is a
 * public page, and the tender's and the contractor's writes answer no-store
 * as their controllers send it. A tender of its own is made for each write
 * that moves one, on A's active budget, so the world's tender stays open.
 */
export function contractorCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const manager = { token: () => w().a.tokens.manager };
  const contractor = { token: () => w().a.tokens.contractor };
  const tender = () => w().aTenderId;
  const linkInvite = async (tenderId = tender()) =>
    (
      await call(w(), 'POST', `/staff/tenders/${tenderId}/invitations`, {
        token: manager.token(),
        body: { companyName: `No-store Co. ${uniqueSuffix()}` },
      })
    ).body as { invitation: { id: string } };
  const as =
    (token: () => string | Promise<string>) =>
    async (method: Method, path: string, body?: object) =>
      call(w(), method, path, { token: await token(), body });
  const m = as(manager.token);
  const c = as(contractor.token);
  /** A's accountant, made once: `tenders.open`, the opening's other hand. */
  let accountantToken: Promise<string> | null = null;
  const acc = as(
    () =>
      (accountantToken ??= boardMatterHelpers(w().h)
        .accountant(w().a)
        .then((who) => who.token)),
  );
  const id = (res: Response) => (res.body as { id: string }).id;

  const draftBody = async () => ({
    title: `No-store tender ${uniqueSuffix()}`,
    scope: 'A no-store call’s tender.',
    category: 'maintenance',
    contractKind: 'service',
    budgetLineId: (await activeBudget(world, sitting)).lineId,
    estimatedValue: '1000.00',
    bidsDueAt: daysLater(2).toISOString(),
  });
  const aDraft = async () =>
    id(done(await m('POST', '/staff/tenders', await draftBody())));
  /** A draft with the contractor's vendor invited, then published. */
  const aPublished = async () => {
    const t = await aDraft();
    done(
      await m('POST', `/staff/tenders/${t}/invitations`, {
        vendorId: w().a.contractorVendorId,
      }),
    );
    done(await m('POST', `/staff/tenders/${t}/publish`), 200);
    return t;
  };
  /**
   * Its deadline moved to just past, as the database's clock cannot be wound
   * on (the move-forward trigger set aside for that one statement).
   */
  const closeBids = (tenderId: string) =>
    superuserSql(
      `UPDATE tenders
          SET created_at = LEAST(created_at, clock_timestamp() - interval '1 hour'),
              bids_due_at = clock_timestamp() - interval '1 second'
        WHERE id = $1::uuid`,
      [tenderId],
    );
  /** Published, bid on by the contractor, past its deadline. */
  const aDue = async () => {
    const t = await aPublished();
    done(
      await c('POST', `/contractor/tenders/${t}/bid`, {
        amount: '900.00',
        durationDays: 30,
      }),
    );
    await closeBids(t);
    return t;
  };
  const aDocument = async (tenderId: string) =>
    id(
      done(
        await m('POST', `/staff/tenders/${tenderId}/documents`, {
          fileId: await fileHelpers(w().h).ready(
            manager.token(),
            'tender_document',
            'application/pdf',
          ),
          title: 'Scope',
        }),
      ),
    );
  /** A contract of the contractor's own vendor, on the active budget. */
  let ownContract: Promise<string> | null = null;
  const aVendorContract = () =>
    (ownContract ??= (async () =>
      id(
        done(
          await m('POST', '/maintenance/contracts', {
            code: `NS-C-${uniqueSuffix()}`,
            kind: 'amc',
            vendorId: w().a.contractorVendorId,
            startsOn: `${today().slice(0, 4)}-01-01`,
            endsOn: `${today().slice(0, 4)}-12-31`,
            annualValue: '12000.00',
            budgetLineId: (await activeBudget(world, sitting)).lineId,
          }),
        ),
      ))());

  return {
    'POST /staff/tenders': async () =>
      m('POST', '/staff/tenders', await draftBody()),
    'PATCH /staff/tenders/{id}': async () =>
      m('PATCH', `/staff/tenders/${await aDraft()}`, {
        title: 'No-store tender, renamed',
      }),
    'POST /staff/tenders/{id}/publish': async () => {
      const t = await aDraft();
      done(
        await m('POST', `/staff/tenders/${t}/invitations`, {
          vendorId: w().a.contractorVendorId,
        }),
      );
      return m('POST', `/staff/tenders/${t}/publish`);
    },
    'POST /staff/tenders/{id}/deadline': async () =>
      m('POST', `/staff/tenders/${await aPublished()}/deadline`, {
        bidsDueAt: daysLater(5).toISOString(),
      }),
    'POST /staff/tenders/{id}/cancel': async () =>
      m('POST', `/staff/tenders/${await aDraft()}/cancel`, {
        reasonCode: 'not_needed',
      }),
    'POST /staff/tenders/{id}/documents': async () => {
      const t = await aDraft();
      return m('POST', `/staff/tenders/${t}/documents`, {
        fileId: await fileHelpers(w().h).ready(
          manager.token(),
          'tender_document',
          'application/pdf',
        ),
        title: 'Scope',
      });
    },
    'DELETE /staff/tenders/{id}/documents/{documentId}': async () => {
      const t = await aDraft();
      return m('DELETE', `/staff/tenders/${t}/documents/${await aDocument(t)}`);
    },
    'POST /staff/tenders/{id}/invitations/{invitationId}/revoke': async () => {
      const t = await aPublished();
      const made = await linkInvite(t);
      return m(
        'POST',
        `/staff/tenders/${t}/invitations/${made.invitation.id}/revoke`,
      );
    },
    // The opening's first hand: the accountant begins it.
    'POST /staff/tenders/{id}/opening': async () =>
      acc('POST', `/staff/tenders/${await aDue()}/opening`),
    'POST /staff/tenders/{id}/award': async () => {
      const t = await aDue();
      done(await acc('POST', `/staff/tenders/${t}/opening`), 200);
      const opened = done(await m('POST', `/staff/tenders/${t}/opening`), 200)
        .body as { bids: { id: string }[] };
      return m('POST', `/staff/tenders/${t}/award`, {
        bidId: opened.bids[0].id,
        code: `NS-T-${uniqueSuffix()}`,
        startsOn: day(10),
        endsOn: day(200),
      });
    },
    // The contractor's invoice against its own vendor's contract.
    'POST /contractor/invoices': async () =>
      c('POST', '/contractor/invoices', {
        vendorNumber: `NS-${uniqueSuffix()}`,
        issuedOn: today(),
        dueOn: day(15),
        contractId: await aVendorContract(),
        invoiceFileId: await fileHelpers(w().h).ready(
          contractor.token(),
          'expense_invoice',
          'application/pdf',
        ),
        lines: [{ description: 'No-store service', amount: '300.00' }],
      }),
    'GET /staff/tenders/{id}': () =>
      call(w(), 'GET', `/staff/tenders/${tender()}`, {
        token: manager.token(),
      }),
    'POST /staff/tenders/{id}/invitations': () =>
      call(w(), 'POST', `/staff/tenders/${tender()}/invitations`, {
        token: manager.token(),
        body: { companyName: 'No-store Outside Co.' },
      }),
    'POST /staff/tenders/{id}/invitations/{invitationId}/link': async () => {
      const made = await linkInvite();
      return call(
        w(),
        'POST',
        `/staff/tenders/${tender()}/invitations/${made.invitation.id}/link`,
        { token: manager.token() },
      );
    },
    'GET /contractor/tenders/{id}': () =>
      call(w(), 'GET', `/contractor/tenders/${tender()}`, {
        token: contractor.token(),
      }),
    'POST /contractor/tenders/{id}/bid': async () => {
      // One live bid an invitation: whatever an earlier call left goes first.
      await call(w(), 'POST', `/contractor/tenders/${tender()}/bid/withdraw`, {
        token: contractor.token(),
      });
      return call(w(), 'POST', `/contractor/tenders/${tender()}/bid`, {
        token: contractor.token(),
        body: { amount: '1500.00' },
      });
    },
    'POST /public/tender-bids/lookup': () =>
      call(w(), 'POST', '/public/tender-bids/lookup', {
        body: { token: w().aBidToken },
      }),
    'POST /public/tender-bids/bid': async () => {
      await call(w(), 'POST', '/public/tender-bids/withdraw', {
        body: { token: w().aBidToken },
      });
      return call(w(), 'POST', '/public/tender-bids/bid', {
        body: { token: w().aBidToken, amount: '1400.00' },
      });
    },
    'POST /public/tender-bids/withdraw': async () => {
      await call(w(), 'POST', '/public/tender-bids/bid', {
        body: { token: w().aBidToken, amount: '1300.00' },
      });
      return call(w(), 'POST', '/public/tender-bids/withdraw', {
        body: { token: w().aBidToken },
      });
    },
  };
}

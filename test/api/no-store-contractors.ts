import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of the contractor portal and tenders
 * (ADR 0088), in A: a tender's views carry documents' URLs, an invitation by
 * link and a new link carry the token shown once, and the bid link's page
 * is a public page.
 */
export function contractorCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const w = () => world();
  const manager = { token: () => w().a.tokens.manager };
  const contractor = { token: () => w().a.tokens.contractor };
  const tender = () => w().aTenderId;
  const linkInvite = async () =>
    (
      await call(w(), 'POST', `/staff/tenders/${tender()}/invitations`, {
        token: manager.token(),
        body: { companyName: 'No-store Co.' },
      })
    ).body as { invitation: { id: string } };
  return {
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

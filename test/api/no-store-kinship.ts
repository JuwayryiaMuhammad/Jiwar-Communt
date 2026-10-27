import type { Response } from 'supertest';
import { HouseholdsService } from '../../src/community/households/households.service';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { communityHelpers } from '../setup/community';
import { fileHelpers } from '../setup/files';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { uniqueEmail, uniquePhone } from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0062's proof of kinship: A's
 * owner invites with a document; for the approver's read, A's joins need
 * approval while the invitee accepts (then no longer).
 */
export function kinshipCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const x = () => communityHelpers(world().h);

  /** An invite of A's owner with one proof: its id, the document's, the token. */
  const invited = async () => {
    const w = world();
    const fileId = await fileHelpers(w.h).ready(
      w.a.tokens.owner,
      'kinship_proof',
      'application/pdf',
    );
    const email = uniqueEmail('kin');
    const invite = await x().as(
      w.a,
      { id: w.a.ids.owner, type: 'resident' },
      () =>
        w.h.moduleRef.get(HouseholdsService).createInvite(w.a.homeUnitId, {
          fullName: 'Invited Brother',
          phone: uniquePhone(),
          email,
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
          relation: 'sibling',
          kinshipDocuments: [{ fileId, kind: 'family_record' }],
        }),
    );
    const doc = await x().asManager(w.a, () =>
      x().prisma.tenant.householdInviteDocument.findFirstOrThrow({
        where: { inviteId: invite.inviteId },
      }),
    );
    return { ...invite, email, documentId: doc.id };
  };

  const approval = (on: boolean) =>
    x().asManager(world().a, () =>
      world()
        .h.moduleRef.get(TenantSettingsService)
        .update({ familyJoinRequiresApproval: on }),
    );

  return {
    'GET /household/invites/{id}/kinship-documents/{documentId}': async () => {
      const i = await invited();
      return call(
        world(),
        'GET',
        `/household/invites/${i.inviteId}/kinship-documents/${i.documentId}`,
        { token: world().a.tokens.owner },
      );
    },
    'GET /household/members/{id}/kinship-documents/{documentId}': async () => {
      const i = await invited();
      await approval(true);
      try {
        const since = new Date();
        const started = await call(world(), 'POST', '/invites/accept/start', {
          body: { token: i.token },
        });
        if (started.status !== 202)
          throw new Error(`accept/start: ${started.status}`);
        const done = await call(world(), 'POST', '/invites/accept/complete', {
          body: { token: i.token, code: await waitForOtp(i.email, since) },
        });
        if (done.status >= 300)
          throw new Error(
            `accept/complete: ${done.status} ${JSON.stringify(done.body)}`,
          );
      } finally {
        await approval(false);
      }
      // The membership the acceptance made (the invite names its account),
      // waiting for approval.
      const { id: memberId } = await x().asManager(world().a, async () => {
        const accepted =
          await x().prisma.tenant.householdInvite.findUniqueOrThrow({
            where: { id: i.inviteId },
          });
        return x().prisma.tenant.householdMember.findFirstOrThrow({
          where: {
            unitId: accepted.unitId,
            accountId: accepted.acceptedAccountId,
            status: 'pending_approval',
          },
        });
      });
      return call(
        world(),
        'GET',
        `/household/members/${memberId}/kinship-documents/${i.documentId}`,
        { token: world().a.tokens.manager },
      );
    },
  };
}

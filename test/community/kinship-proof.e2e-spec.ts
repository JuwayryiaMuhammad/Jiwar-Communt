import { HouseholdsService } from '../../src/community/households/households.service';
import { KINSHIP_RETENTION_SWEEP } from '../../src/community/households/kinship-documents';
import type { NewInvite } from '../../src/community/households/households.types';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { communityHelpers } from '../setup/community';
import { daysLater } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { permitHelpers } from '../setup/permits';
import { inAMonth } from '../api/routes/delegations';

/**
 * Proof of kinship on an invite, and the `permits` delegation (ADR 0062).
 */
describe('Proof of kinship and delegated permits', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let x: ReturnType<typeof communityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof permitHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    x = communityHelpers(h);
    s = await p.setUp('Kinship Court');
  }, 180_000);

  afterAll(() => h.close());

  const settings = (update: Parameters<TenantSettingsService['update']>[0]) =>
    x.asManager(s.c, () =>
      h.moduleRef.get(TenantSettingsService).update(update),
    );

  const proof = () =>
    fileHelpers(h).ready(s.alice.token, 'kinship_proof', 'application/pdf');

  function invite(over: Partial<NewInvite> = {}) {
    return x.as(s.c, { id: s.alice.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).createInvite(s.home.id, {
        fullName: 'Invited Cousin',
        phone: uniquePhone(),
        email: uniqueEmail('kin'),
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(28)),
        relation: 'other',
        ...over,
      }),
    );
  }

  const get = (path: string, token: string) =>
    h.http().get(`${API}${path}`).set('Authorization', `Bearer ${token}`);

  const docOf = (inviteId: string) =>
    x.asManager(s.c, () =>
      x.prisma.tenant.householdInviteDocument.findFirstOrThrow({
        where: { inviteId },
        include: { file: true },
      }),
    );

  it('optional: an invite takes a proof; the inviter reads it, a stranger does not', async () => {
    const fileId = await proof();
    const created = await invite({
      kinshipDocuments: [{ fileId, kind: 'birth_certificate' }],
    });
    const doc = await docOf(created.inviteId);
    expect(doc.file).toMatchObject({ ownerAccountId: null });
    const res = await get(
      `/household/invites/${created.inviteId}/kinship-documents/${doc.id}`,
      s.alice.token,
    ).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as { kind: string }).kind).toBe('birth_certificate');

    const elsewhere = await x.unit(s.c);
    const stranger = await p.who(
      s.c,
      (await x.resident(s.c, [elsewhere.id])).id,
      'resident',
    );
    const refused = await get(
      `/household/invites/${created.inviteId}/kinship-documents/${doc.id}`,
      stranger.token,
    );
    expect(refused.status).toBeGreaterThanOrEqual(403);
    // Someone else's file is not the inviter's to attach.
    const theirs = await fileHelpers(h).ready(
      stranger.token,
      'kinship_proof',
      'application/pdf',
    );
    await expect(
      invite({ kinshipDocuments: [{ fileId: theirs, kind: 'other' }] }),
    ).rejects.toMatchObject({ response: { code: 'FILE_NOT_FOUND' } });
  });

  it('off refuses a proof; required (with approval) needs one', async () => {
    await settings({ familyKinshipProof: 'off' });
    try {
      await expect(
        invite({
          kinshipDocuments: [{ fileId: await proof(), kind: 'other' }],
        }),
      ).rejects.toMatchObject({
        response: {
          fields: [{ field: 'kinshipDocuments', code: 'FIELD_NOT_ALLOWED' }],
        },
      });
      await settings({ familyKinshipProof: 'required' });
      // Without approval, "required" has no one to read it: not enforced.
      await invite();
      await settings({ familyJoinRequiresApproval: true });
      await expect(invite()).rejects.toMatchObject({
        response: { code: 'KINSHIP_PROOF_REQUIRED' },
      });
    } finally {
      await settings({
        familyKinshipProof: 'optional',
        familyJoinRequiresApproval: false,
      });
    }
  });

  it('the approver reads it while the join waits; it is released once decided and deleted 30 days on', async () => {
    await settings({ familyJoinRequiresApproval: true });
    let memberId: string;
    try {
      const fileId = await proof();
      const joined = await x.joinFamily(s.c, s.home.id, s.alice, {
        kinshipDocuments: [{ fileId, kind: 'marriage_certificate' }],
      });
      memberId = joined.memberId;
    } finally {
      await settings({ familyJoinRequiresApproval: false });
    }
    const pending = await get('/household/pending', s.manager.token).expect(
      200,
    );
    const mine = (
      pending.body as {
        data: {
          memberId: string;
          kinshipDocuments: { id: string; kind: string }[];
        }[];
      }
    ).data.find((m) => m.memberId === memberId)!;
    expect(mine.kinshipDocuments).toEqual([
      expect.objectContaining({ kind: 'marriage_certificate' }),
    ]);
    const docId = mine.kinshipDocuments[0].id;
    await get(
      `/household/members/${memberId}/kinship-documents/${docId}`,
      s.manager.token,
    ).expect(200);

    await x.asManager(s.c, () =>
      h.moduleRef.get(HouseholdsService).approveMember(memberId),
    );
    await get(
      `/household/members/${memberId}/kinship-documents/${docId}`,
      s.manager.token,
    ).expect(404);

    const sweep = h.moduleRef.get(SweepRunner);
    await sweep.run(KINSHIP_RETENTION_SWEEP, new Date());
    const released = await x.asManager(s.c, () =>
      x.prisma.tenant.householdInviteDocument.findUniqueOrThrow({
        where: { id: docId },
        include: { file: true },
      }),
    );
    expect(released.releasedAt).not.toBeNull();
    expect(released.file.deletedAt).toBeNull();
    await sweep.run(KINSHIP_RETENTION_SWEEP, daysLater(31));
    const gone = await x.asManager(s.c, () =>
      x.prisma.tenant.storedFile.findUnique({ where: { id: released.fileId } }),
    );
    expect(gone?.deletedAt ?? 'purged').not.toBeNull();
  });

  it('a `permits` delegate asks for works; a `household` delegate may not', async () => {
    const bob = await x.joinFamily(s.c, s.home.id, s.alice);
    const carol = await x.joinFamily(s.c, s.home.id, s.alice);
    for (const [who, scopes] of [
      [bob, ['permits']],
      [carol, ['household']],
    ] as const)
      await h
        .http()
        .post(`${API}/units/${s.home.id}/delegations`)
        .set('Authorization', `Bearer ${s.alice.token}`)
        .send({
          delegateAccountId: who.accountId,
          scopes,
          expiresAt: inAMonth(),
        })
        .expect(201);
    const asBob = await p.who(s.c, bob.accountId, 'family');
    const asCarol = await p.who(s.c, carol.accountId, 'family');
    const made = await p.worksRaw(asBob, s.home.id);
    expect(made.status).toBe(201);
    const refused = await p.worksRaw(asCarol, s.home.id);
    expect([refused.status, (refused.body as { code: string }).code]).toEqual([
      403,
      'PERMIT_NOT_ALLOWED',
    ]);
  });
});

import {
  contentSha256,
  type SignedMaterial,
} from '../../src/gate/incidents/incident-signature-content';
import { dbClock } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

interface SignatureBody {
  id: string;
  role: 'author' | 'reviewer';
  signer: { id: string };
  signedAt: string;
  contentSha256: string;
  canonicalVersion: number;
  superseded: boolean;
  image: { url: string } | null;
  imageCleared: boolean;
}

/**
 * ADR 0056, drawn signatures on the incident report. The author signs as
 * `author`, a keeper who did not report it as `reviewer`, each over the
 * SHA-256 of the report's canonical content for the role. A signature
 * never changes; it reads superseded once the content of its role
 * changed. Closing supersedes the reviewer's, never the author's; evidence
 * linked later, both. At the signer's erasure its image goes; the hash
 * and the time stay.
 */
describe('Incident signatures (ADR 0056)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let keeper: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Signatures Court');
    guard = await x.guardOnDuty(s.c);
    keeper = await x.staff(s.c, ['incidents.manage']);
  }, 180_000);

  afterAll(() => h.close());

  const report = async (as: Who = guard, side: 'gate' | 'staff' = 'gate') =>
    (
      await x
        .http(
          'post',
          side === 'gate' ? '/gate/incidents' : '/staff/security/incidents',
          as.token,
          {
            type: 'hazard',
            severity: 'medium',
            unitCode: s.home.code,
            occurredAt: new Date(dbClock().getTime() - 600_000).toISOString(),
            description: 'A loose cable by the pool',
          },
        )
        .expect(201)
    ).body as { id: string };
  const signRaw = (
    as: Who,
    incidentId: string,
    role: string,
    side: 'gate' | 'staff' = as === guard ? 'gate' : 'staff',
  ) =>
    x
      .photo(as, 'incident_signature')
      .then((fileId) =>
        x.http(
          'post',
          `${side === 'gate' ? '/gate/incidents' : '/staff/security/incidents'}/${incidentId}/signatures`,
          as.token,
          { role, fileId },
        ),
      );
  /** A signature that must be taken (201). */
  const signed201 = async (res: Promise<{ status: number; body: unknown }>) => {
    const r = await res;
    expect(r.status).toBe(201);
    return r.body as SignatureBody;
  };
  const sign = (as: Who, incidentId: string, role: string) =>
    signed201(signRaw(as, incidentId, role));
  const listed = async (incidentId: string) =>
    (
      (
        await x
          .http(
            'get',
            `/staff/security/incidents/${incidentId}/signatures`,
            keeper.token,
          )
          .expect(200)
      ).body as { data: SignatureBody[] }
    ).data;
  const close = (incidentId: string) =>
    x
      .http(
        'post',
        `/staff/security/incidents/${incidentId}/close`,
        keeper.token,
        { reasonCode: 'resolved', note: 'Fixed by maintenance' },
      )
      .expect(200);
  const exportOf = async (who: Who) => {
    const email = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: who.id } }),
      )
    ).email!;
    await stepUp(h, who.token, email);
    const asked = await x
      .http('post', '/me/data-exports', who.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await x
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        who.token,
      )
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  };
  /** The report as the server hashes it, read from its rows. */
  const material = (incidentId: string): Promise<SignedMaterial> =>
    x.inTx(s.c, async (tx) => ({
      incident: await tx.incident.findUniqueOrThrow({
        where: { id: incidentId },
      }),
      photoFileIds: (
        await tx.incidentPhoto.findMany({ where: { incidentId } })
      ).map((p) => p.fileId),
      mediaFileIds: (
        await tx.incidentMedia.findMany({ where: { incidentId } })
      ).map((m) => m.fileId),
      evidenceIds: (
        await tx.incidentEvidence.findMany({ where: { incidentId } })
      ).map((e) => e.id),
    }));

  it('the author signs their report over its canonical content; its image is read back', async () => {
    const incident = await report();
    const signed = await sign(guard, incident.id, 'author');
    expect(signed).toMatchObject({
      role: 'author',
      signer: { id: guard.id },
      canonicalVersion: 1,
      superseded: false,
      imageCleared: false,
    });
    expect(signed.image?.url).toMatch(/^https?:\/\//);
    expect(signed.contentSha256).toBe(
      contentSha256('author', await material(incident.id)),
    );
    const mine = (
      (
        await x
          .http('get', `/gate/incidents/${incident.id}/signatures`, guard.token)
          .expect(200)
      ).body as { data: SignatureBody[] }
    ).data;
    expect(mine.map((m) => m.id)).toEqual([signed.id]);
    // Once per role and content.
    expect(code(await signRaw(guard, incident.id, 'author'))).toEqual({
      status: 409,
      code: 'INCIDENT_ALREADY_SIGNED',
    });
  });

  it('who signs as what: the author as author; a keeper who did not report it as reviewer; another guard sees nothing', async () => {
    const incident = await report();
    expect(code(await signRaw(guard, incident.id, 'reviewer'))).toEqual({
      status: 403,
      code: 'INCIDENT_SIGNER_NOT_ELIGIBLE',
    });
    expect(code(await signRaw(keeper, incident.id, 'author'))).toEqual({
      status: 403,
      code: 'INCIDENT_SIGNER_NOT_ELIGIBLE',
    });
    const colleague = await x.guardOnDuty(s.c);
    expect(
      code(await signRaw(colleague, incident.id, 'author', 'gate')),
    ).toEqual({ status: 404, code: 'INCIDENT_NOT_FOUND' });
    // A keeper's own report: they sign it as its author, never as reviewer.
    const own = await report(keeper, 'staff');
    expect((await sign(keeper, own.id, 'author')).role).toBe('author');
    expect(code(await signRaw(keeper, own.id, 'reviewer'))).toEqual({
      status: 403,
      code: 'INCIDENT_SIGNER_NOT_ELIGIBLE',
    });
    // Another's signature file is not the caller's to use.
    const theirs = await x.photo(keeper, 'incident_signature');
    expect(
      (
        await x
          .http(
            'post',
            `/gate/incidents/${incident.id}/signatures`,
            guard.token,
            {
              role: 'author',
              fileId: theirs,
            },
          )
          .expect(400)
      ).body,
    ).toMatchObject({
      fields: [{ field: 'fileId', code: 'FILE_NOT_AVAILABLE' }],
    });
  });

  it('closing supersedes the reviewer’s signature, never the author’s; the reviewer signs again', async () => {
    const incident = await report();
    const author = await sign(guard, incident.id, 'author');
    const reviewer = await sign(keeper, incident.id, 'reviewer');
    await close(incident.id);
    const after = await listed(incident.id);
    expect(after.map((a) => [a.id, a.superseded])).toEqual([
      [author.id, false],
      [reviewer.id, true],
    ]);
    // What was signed never changes.
    expect(after[1].contentSha256).toBe(reviewer.contentSha256);
    const again = await sign(keeper, incident.id, 'reviewer');
    expect(again.superseded).toBe(false);
    expect(again.contentSha256).not.toBe(reviewer.contentSha256);
    expect(again.contentSha256).toBe(
      contentSha256('reviewer', await material(incident.id)),
    );
  });

  it('a change inside the author’s scope — evidence linked — supersedes both', async () => {
    const incident = await report();
    const pass = await x.passWithCode(s.alice, s.home.id);
    const entry = (
      await x
        .entryRaw(guard, 'visitor_pass', pass.id, {
          photoFileId: await x.photo(guard, 'visitor_photo'),
        })
        .expect(201)
    ).body as { id: string };
    const author = await sign(guard, incident.id, 'author');
    const reviewer = await sign(keeper, incident.id, 'reviewer');
    await x
      .http('post', `/gate/incidents/${incident.id}/evidence`, guard.token, {
        kind: 'visitor_photo',
        entryId: entry.id,
      })
      .expect(201);
    expect(
      (await listed(incident.id)).map((a) => [a.id, a.superseded]),
    ).toEqual([
      [author.id, true],
      [reviewer.id, true],
    ]);
    const again = await sign(guard, incident.id, 'author');
    expect(again.superseded).toBe(false);
  });

  it('nothing of a signature changes in the database but its image going, once', async () => {
    const incident = await report();
    const signed = await sign(guard, incident.id, 'author');
    const sql = (stmt: string) =>
      x.inTx(s.c, (tx) => tx.$executeRawUnsafe(stmt));
    for (const set of [
      `content_sha256 = '${'0'.repeat(64)}'`,
      `role = 'reviewer'`,
      `signed_at = signed_at - interval '1 minute'`,
    ])
      await expect(
        sql(`UPDATE incident_signatures SET ${set} WHERE id = '${signed.id}'`),
      ).rejects.toThrow(/a signature never changes/);
    await expect(
      sql(`DELETE FROM incident_signatures WHERE id = '${signed.id}'`),
    ).rejects.toThrow(/permission denied|never changes/);
  });

  it('at its signer’s erasure: the image goes; the hash and the time stay; the cleared words supersede it', async () => {
    const leaving = await x.guardOnDuty(s.c);
    const incident = await report(leaving);
    const signed = await signed201(
      signRaw(leaving, incident.id, 'author', 'gate'),
    );
    const fileId = (
      await x.inTx(s.c, (tx) =>
        tx.incidentSignature.findUniqueOrThrow({ where: { id: signed.id } }),
      )
    ).fileId!;
    await x
      .http('patch', `/accounts/${leaving.id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    await eraseNow(h, s.c, leaving.id);
    const [after] = await listed(incident.id);
    expect(after).toMatchObject({
      id: signed.id,
      contentSha256: signed.contentSha256,
      signedAt: signed.signedAt,
      image: null,
      imageCleared: true,
      // Its words went with its author: the content signed is not there.
      superseded: true,
    });
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findUnique({ where: { id: fileId } }),
    );
    expect(file === null || file.deletedAt !== null).toBe(true);
  });

  it('the signer’s export holds what they signed: the role, the time and the hash, never the image', async () => {
    const incident = await report();
    const signed = await sign(guard, incident.id, 'author');
    const archive = await exportOf(guard);
    expect(JSON.parse(archive.text('incidents/signatures.json'))).toEqual(
      expect.arrayContaining([
        {
          incident: expect.stringMatching(/^I-\d{4}$/) as string,
          role: 'author',
          signedAt: signed.signedAt,
          contentSha256: signed.contentSha256,
        },
      ]),
    );
    const { fileId } = await x.inTx(s.c, (tx) =>
      tx.incidentSignature.findUniqueOrThrow({ where: { id: signed.id } }),
    );
    expect(archive.all).not.toContain(fileId!);
  });
});

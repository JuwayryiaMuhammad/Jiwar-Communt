import type { Response } from 'supertest';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { communityHelpers } from '../setup/community';
import { SAMPLE } from '../setup/files';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import { uniqueEmail, uniquePhone } from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0062: a fresh registration
 * request in A for each, with its status link (derived as its email's
 * renderer does) and, where the route needs one, a document.
 */
export function registrationCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const service = () => world().h.moduleRef.get(RegistrationService);
  const asManager = <T>(fn: () => Promise<T>) =>
    communityHelpers(world().h).asManager(world().a, fn);

  /** A pending request in A: its id and its live status link token. */
  const registered = async (): Promise<{ id: string; token: string }> => {
    const { token: linkToken } = await asManager(() => service().createLink());
    const r = {
      linkToken,
      fullName: `No-store ${uniqueSuffix()}`,
      unitCode: 'NS-1',
      phone: uniquePhone(),
      email: uniqueEmail('ns-reg'),
      idDocumentType: 'national_id' as const,
      idDocumentNumber: nationalIdFor(),
      occupancyType: 'tenant' as const,
    };
    const since = new Date();
    await service().start(r, '10.98.0.1', 'en');
    await service().complete(r, await waitForOtp(r.email, since), '10.98.0.1');
    const { items } = await asManager(() => service().pending());
    const { id } = items.find((p) => p.email === r.email)!;
    return { id, token: tokenOf(id, 1) };
  };
  const tokenOf = (id: string, seq: number) =>
    world()
      .h.moduleRef.get(IdentifierHasher)
      .registrationStatusToken(world().a.tenantId, id, seq);

  const pub = (path: string, body: object) =>
    call(world(), 'POST', `/public/registrations${path}`, { body });
  const pdf = SAMPLE['application/pdf'];
  /** A document uploaded (not finalized): its id. */
  const uploaded = async (token: string): Promise<string> => {
    const res = await pub('/uploads', {
      token,
      kind: 'lease_proof',
      contentType: 'application/pdf',
      size: pdf.length,
    });
    const body = res.body as {
      document: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };
    await fetch(body.upload.url, {
      method: 'PUT',
      body: new Uint8Array(pdf),
      headers: body.upload.headers,
    });
    return body.document.id;
  };

  return {
    'POST /public/registrations/status': async () =>
      pub('/status', { token: (await registered()).token }),
    'POST /public/registrations/uploads': async () =>
      pub('/uploads', {
        token: (await registered()).token,
        kind: 'ownership_proof',
        contentType: 'application/pdf',
        size: pdf.length,
      }),
    'POST /public/registrations/documents/{id}/finalize': async () => {
      const { token } = await registered();
      return pub(`/documents/${await uploaded(token)}/finalize`, { token });
    },
    'POST /public/registrations/documents/{id}/remove': async () => {
      const { token } = await registered();
      return pub(`/documents/${await uploaded(token)}/remove`, { token });
    },
    'POST /public/registrations/resubmit': async () => {
      const { id, token } = await registered();
      await pub(`/documents/${await uploaded(token)}/finalize`, { token });
      await asManager(() =>
        service().requestCorrection(id, { codes: ['document_missing'] }),
      );
      return pub('/resubmit', { token: tokenOf(id, 2) });
    },
    'GET /registrations/{id}/documents/{documentId}': async () => {
      const { id, token } = await registered();
      const documentId = await uploaded(token);
      await pub(`/documents/${documentId}/finalize`, { token });
      return call(
        world(),
        'GET',
        `/registrations/${id}/documents/${documentId}`,
        {
          token: world().a.tokens.manager,
        },
      );
    },
  };
}

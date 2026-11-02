import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** Announcements and the office queue (ADR 0080) as the API suites see it. */
export interface M29World {
  /** A's own management topic, for bodies that must pass validation. */
  aManagementTopicId: string;
  bAnnouncementTemplateId: string;
  bReplyTemplateId: string;
  /** An official letter of B's owner. */
  bLetterId: string;
}

export async function m29World(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  a: Side,
  b: Side,
): Promise<M29World> {
  const tenantTx = h.moduleRef.get(TenantTx);
  const aManagementTopicId = await helpers.asManager(a, () =>
    tenantTx.withTenantTx(
      async (tx) =>
        (
          await tx.managementRequestTopic.findFirstOrThrow({
            where: { key: 'general' },
          })
        ).id,
    ),
  );
  const ids = await helpers.asManager(b, () =>
    tenantTx.withTenantTx(async (tx) => {
      const template = await tx.announcementTemplate.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          name: 'World template',
          titleEn: 'World',
          bodyEn: 'World.',
          createdById: b.ids.manager,
        },
      });
      const reply = await tx.requestReplyTemplate.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          name: 'World reply',
          bodyEn: 'World.',
          createdById: b.ids.manager,
        },
      });
      const letter = await tx.officialLetter.create({
        data: {
          id: newId(),
          tenantId: b.tenantId,
          number: 1,
          kind: 'residence_confirmation',
          unitId: b.homeUnitId,
          accountId: b.ids.owner,
          subjectName: 'World Owner',
          occupancyType: 'owner',
          occupancySince: new Date('2026-01-01T00:00:00Z'),
          issuedById: b.ids.manager,
          issuedAt: new Date(),
          verifyCode: newId().replace(/-/g, '').slice(0, 22),
          template: 'certificate.v2',
        },
      });
      return {
        bAnnouncementTemplateId: template.id,
        bReplyTemplateId: reply.id,
        bLetterId: letter.id,
      };
    }),
  );
  return { aManagementTopicId, ...ids };
}

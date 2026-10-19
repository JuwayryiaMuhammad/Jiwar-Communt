import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { safetyReference } from '../safety/safety-rules';

/**
 * The incidents section of a personal-data export (ADR 0053),
 * `incidents/`, for whoever reported, wrote on, closed or acknowledged
 * one (a guard or the management; residents have none):
 * - `reported.json`: the incidents it reported: reference, type,
 *   severity, place and unit, when, its own words while they last, how
 *   many photos, the status and outcome — never the investigation;
 * - `notes.json`: the internal notes it wrote and the closing notes of the
 *   incidents it closed, its own words only;
 * - `acknowledgements.json`: what it acknowledged, as author or reviewer.
 * Nobody else's name or words.
 */
@Injectable()
export class IncidentExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('incidents', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const d = await this.tenantTx.withTenantTx(async (tx) => {
      const reported = await tx.incident.findMany({
        where: { reportedById: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const closed = await tx.incident.findMany({
        where: { closedById: me },
        orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
      });
      const notes = await tx.incidentNote.findMany({
        where: { authorId: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const acks = await tx.incidentAcknowledgement.findMany({
        where: { accountId: me },
        orderBy: [{ acknowledgedAt: 'asc' }, { incidentId: 'asc' }],
      });
      // What it signed (ADR 0056): the role and the time, never the image.
      const signatures = await tx.incidentSignature.findMany({
        where: { signerAccountId: me },
        orderBy: [{ signedAt: 'asc' }, { id: 'asc' }],
      });
      const photos = new Map<string, number>();
      for (const p of reported.length
        ? await tx.incidentPhoto.findMany({
            where: { incidentId: { in: reported.map((i) => i.id) } },
            select: { incidentId: true },
          })
        : [])
        photos.set(p.incidentId, (photos.get(p.incidentId) ?? 0) + 1);
      // Its recordings, counted as its photos are (ADR 0056).
      const media = new Map<string, number>();
      for (const m of reported.length
        ? await tx.incidentMedia.findMany({
            where: { incidentId: { in: reported.map((i) => i.id) } },
            select: { incidentId: true },
          })
        : [])
        media.set(m.incidentId, (media.get(m.incidentId) ?? 0) + 1);
      const known = new Map(
        [...reported, ...closed].map((i) => [i.id, i.number]),
      );
      const missing = [
        ...new Set([
          ...notes.map((n) => n.incidentId),
          ...acks.map((a) => a.incidentId),
          ...signatures.map((x) => x.incidentId),
        ]),
      ].filter((id) => !known.has(id));
      for (const i of missing.length
        ? await tx.incident.findMany({
            where: { id: { in: missing } },
            select: { id: true, number: true },
          })
        : [])
        known.set(i.id, i.number);
      const places = new Map(
        (
          await tx.place.findMany({
            where: {
              id: {
                in: reported.flatMap((i) => (i.placeId ? [i.placeId] : [])),
              },
            },
            select: { id: true, nameEn: true },
          })
        ).map((p) => [p.id, p.nameEn]),
      );
      const codes = await this.community.unitCodes(
        tx,
        reported.flatMap((i) => (i.unitId ? [i.unitId] : [])),
      );
      return {
        reported,
        closed,
        notes,
        acks,
        signatures,
        photos,
        media,
        known,
        places,
        codes,
      };
    });
    const ref = (id: string) => {
      const n = d.known.get(id);
      return n === undefined ? null : safetyReference('I', n);
    };
    yield {
      path: 'incidents/reported.json',
      json: d.reported.map((i) => ({
        reference: safetyReference('I', i.number),
        type: i.type,
        severity: i.severity,
        place: i.placeId ? (d.places.get(i.placeId) ?? null) : null,
        unitCode: i.unitId ? (d.codes.get(i.unitId) ?? null) : null,
        occurredAt: i.occurredAt,
        description: i.description,
        photos: d.photos.get(i.id) ?? 0,
        media: d.media.get(i.id) ?? 0,
        status: i.status,
        outcome: i.outcome,
        createdAt: i.createdAt,
        closedAt: i.closedAt,
      })),
    };
    yield {
      path: 'incidents/notes.json',
      json: [
        ...d.notes.map((n) => ({
          incident: ref(n.incidentId),
          kind: 'note',
          text: n.body,
          writtenAt: n.createdAt,
        })),
        ...d.closed.map((i) => ({
          incident: safetyReference('I', i.number),
          kind: 'closing_note',
          text: i.closingNote,
          writtenAt: i.closedAt,
        })),
      ],
    };
    yield {
      path: 'incidents/acknowledgements.json',
      json: d.acks.map((a) => ({
        incident: ref(a.incidentId),
        role: a.role,
        acknowledgedAt: a.acknowledgedAt,
      })),
    };
    yield {
      path: 'incidents/signatures.json',
      json: d.signatures.map((x) => ({
        incident: ref(x.incidentId),
        role: x.role,
        signedAt: x.signedAt,
        contentSha256: x.contentSha256,
      })),
    };
  }
}

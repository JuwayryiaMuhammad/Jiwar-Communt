import type { BoardDocumentSection } from '../reports/board-document-pdf';

/** What a handover snapshot holds (handovers.service.ts packContents). */
export interface HandoverContents {
  asOf?: string;
  approvals?: {
    pending?: { reference: string; type: string; deadlineAt: string }[];
    awaitingImplementation?: {
      reference: string;
      type: string;
      decidedAt: string | null;
    }[];
  };
  appeals?: {
    pending?: { reference: string; kind: string; deadlineAt: string }[];
  };
  objectionsUnanswered?: number;
  agendaProposalsOpen?: number;
  openActions?: { meetingReference: string; title: string; dueOn: string }[];
  latestMinutes?: { publicationId: string; decidedOn: string } | null;
  sections?: Record<string, Record<string, unknown>>;
  previousTerm?: { startsAt: string; endsAt: string } | null;
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * A handover snapshot as the PDF's sections, in English and Arabic
 * headings; the lines are references, codes, days and amounts as stored.
 */
export function handoverSections(
  c: HandoverContents,
  notes: string | null,
): BoardDocumentSection[] {
  const out: BoardDocumentSection[] = [];
  if (notes !== null)
    out.push({
      headingEn: 'The manager’s notes',
      headingAr: 'ملاحظات المدير',
      lines: notes.split('\n').filter((l) => l.trim()),
    });
  out.push(
    {
      headingEn: 'Requests awaiting the board',
      headingAr: 'طلبات بانتظار المجلس',
      lines: (c.approvals?.pending ?? []).map(
        (r) => `${r.reference} · ${r.type} · due ${day(r.deadlineAt)}`,
      ),
    },
    {
      headingEn: 'Approved, not yet implemented',
      headingAr: 'معتمدة ولم تنفذ بعد',
      lines: (c.approvals?.awaitingImplementation ?? []).map(
        (r) =>
          `${r.reference} · ${r.type}${r.decidedAt ? ` · approved ${day(r.decidedAt)}` : ''}`,
      ),
    },
    {
      headingEn: 'Appeals awaiting the board',
      headingAr: 'تظلمات بانتظار المجلس',
      lines: (c.appeals?.pending ?? []).map(
        (a) => `${a.reference} · ${a.kind} · due ${day(a.deadlineAt)}`,
      ),
    },
    {
      headingEn: 'Open action items',
      headingAr: 'مهام مفتوحة',
      lines: (c.openActions ?? []).map(
        (a) => `${a.meetingReference} · ${a.title} · due ${a.dueOn}`,
      ),
    },
    {
      headingEn: 'The owners’ voice',
      headingAr: 'صوت الملاك',
      lines: [
        `Decisions with unanswered objections: ${c.objectionsUnanswered ?? 0}`,
        `Open agenda proposals: ${c.agendaProposalsOpen ?? 0}`,
        c.latestMinutes
          ? `Latest minutes: ${c.latestMinutes.decidedOn}`
          : 'No minutes published',
      ],
    },
  );
  const contracts = c.sections?.contracts as
    | {
        withinDays: number;
        ending: { code: string; kind: string; endsOn: string }[];
      }
    | undefined;
  if (contracts)
    out.push({
      headingEn: `Contracts ending within ${contracts.withinDays} days`,
      headingAr: `عقود تنتهي خلال ${contracts.withinDays} يومًا`,
      lines: contracts.ending.map((x) => `${x.code} · ${x.kind} · ${x.endsOn}`),
    });
  const budget = c.sections?.budget as
    | {
        currency: string;
        active: { fiscalYear: number; allowance: string; spent: string }[];
      }
    | undefined;
  if (budget)
    out.push({
      headingEn: 'The active budget',
      headingAr: 'الموازنة السارية',
      lines: budget.active.map(
        (b) =>
          `${b.fiscalYear}: ${b.spent} of ${b.allowance} ${budget.currency} spent`,
      ),
    });
  return out;
}

/**
 * Decision appeals (ADR 0059): what the management's pages say of them.
 * Pure, so node:test covers it; the words are in the money-appeals catalog.
 */
import type { Translate } from '@jiwar/i18n/core';
import type appealsEn from '../../messages/en/money-appeals.ts';

type T = Translate<typeof appealsEn>;

/** What a resident may appeal. */
export const KINDS = ['permit_rejection', 'vehicle_rejection', 'worker_rejection', 'neighbour_notice'] as const;

export const STATUSES = ['pending', 'upheld', 'overturned', 'withdrawn'] as const;

export const EFFECTS = ['applied', 'follow_up', 'none'] as const;

/** Why an overturn was left to the management: the check that refused it. */
export const EFFECT_REASONS = [
  'window_passed',
  'purged',
  'requester_gone',
  'unit_limit',
  'work_rules',
  'blocklisted',
  'deposit_required',
  'needs_sticker',
  'registrant_gone',
  'plate_active',
  'permit_date',
  'sticker_used',
  'changed',
  'needs_review',
] as const;

const among = <C extends string>(codes: readonly C[], code: string): code is C => (codes as readonly string[]).includes(code);

/** A kind's words; an unknown kind shows as its code. */
export const kindText = (t: T, kind: string) => (among(KINDS, kind) ? t(`kind.${kind}`) : kind);

/** A status's words (`Upheld: the decision stands`). */
export const statusText = (t: T, status: string) => (among(STATUSES, status) ? t(`status.${status}`) : status);

/** An effect's words (`For the management to follow up`). */
export const effectText = (t: T, effect: string) => (among(EFFECTS, effect) ? t(`effect.${effect}`) : effect);

/** A vehicle's overturn asks what its approval asks: a sticker and a last day. */
export const needsSticker = (kind: string, outcome: string) =>
  kind === 'vehicle_rejection' && outcome === 'overturned';

/** What the decided appeal says, in one line. */
export function decisionLine(
  d: {
    outcome: string;
    effect: string;
    effectReason: string | null;
  },
  t: T,
): string {
  const base = statusText(t, d.outcome);
  if (d.outcome !== 'overturned') return base;
  const effect = effectText(t, d.effect);
  if (!d.effectReason) return `${base} · ${effect}`;
  const reason = among(EFFECT_REASONS, d.effectReason) ? t(`effectReason.${d.effectReason}`) : d.effectReason;
  return t('line.effectReason', { status: base, effect, reason });
}

/** Where the decision appealed is opened in the dashboard, if anywhere. */
export function subjectHref(kind: string, subjectId: string): string | null {
  switch (kind) {
    case 'permit_rejection':
      return `/permits/${subjectId}`;
    case 'vehicle_rejection':
      // The vehicles' list: it has no page of one.
      return '/vehicles';
    default:
      return null;
  }
}

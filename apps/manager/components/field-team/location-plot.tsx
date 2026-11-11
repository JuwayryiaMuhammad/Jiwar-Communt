'use client';

import { useFormat, useT } from '@jiwar/i18n';
import ar from '@/messages/ar/ops-field-team';
import en from '@/messages/en/ops-field-team';
import { ringStep } from './logic';

const SIZE = 240;
const CENTRE = SIZE / 2;
const RADIUS = 100;

/**
 * One technician's last known point (ADR 0090), plotted on its own: the point
 * at the centre, rings every few metres, north up, and the circle of the
 * point's accuracy. It draws no street or building and loads nothing from
 * outside: the coordinates still open the public map in a new tab. It shows
 * one point of one technician, never several.
 */
export function LocationPlot({ latitude, longitude, accuracyMeters }: { latitude: number; longitude: number; accuracyMeters: number | null }) {
  const t = useT(en, ar);
  const f = useFormat();
  const step = ringStep(accuracyMeters);
  const perMetre = RADIUS / (step * 3);
  const accuracy = accuracyMeters === null ? null : Math.min(RADIUS * 1.2, accuracyMeters * perMetre);
  const summary = t('plotSummary', {
    latitude: latitude.toFixed(5),
    longitude: longitude.toFixed(5),
    ring: f.number(step),
  });
  return (
    <figure style={{ margin: 0 }}>
      <svg role="img" aria-label={summary} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} style={{ maxWidth: '100%', height: 'auto' }}>
        <title>{summary}</title>
        <rect x={0} y={0} width={SIZE} height={SIZE} rx={8} fill="var(--surface-soft, #f6f3ee)" stroke="var(--hairline-soft, #ddd)" />
        {[1, 2, 3].map((n) => (
          <circle key={n} cx={CENTRE} cy={CENTRE} r={(RADIUS / 3) * n} fill="none" stroke="var(--hairline-soft, #ccc)" strokeDasharray="3 3" />
        ))}
        <line x1={CENTRE} y1={CENTRE - RADIUS - 8} x2={CENTRE} y2={CENTRE + RADIUS + 8} stroke="var(--hairline-soft, #ccc)" />
        <line x1={CENTRE - RADIUS - 8} y1={CENTRE} x2={CENTRE + RADIUS + 8} y2={CENTRE} stroke="var(--hairline-soft, #ccc)" />
        {accuracy !== null ? <circle cx={CENTRE} cy={CENTRE} r={accuracy} fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeOpacity={0.5} /> : null}
        <circle cx={CENTRE} cy={CENTRE} r={5} fill="currentColor" />
        <text x={CENTRE} y={14} textAnchor="middle" fontSize={12} fill="currentColor">
          {t('north')}
        </text>
        <text x={SIZE - 8} y={SIZE - 8} textAnchor="end" fontSize={11} fill="currentColor">
          {t('ringScale', { m: f.number(step) })}
        </text>
      </svg>
      <figcaption className="t-secondary" style={{ fontSize: 12 }}>
        {t('plotCaption', { m: f.number(step) })}
      </figcaption>
    </figure>
  );
}

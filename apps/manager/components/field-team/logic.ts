/** The distances a ring of a location plot may stand for, in metres. */
export const RING_STEPS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000] as const;

/**
 * The ring spacing of the plot of a technician's last point (ADR 0090): the
 * smallest step for which the accuracy circle fits inside three rings. With
 * no accuracy the smallest step; past the largest, the largest.
 */
export function ringStep(accuracyMeters: number | null): number {
  const need = accuracyMeters ?? 0;
  return RING_STEPS.find((s) => s * 3 >= need) ?? RING_STEPS[RING_STEPS.length - 1]!;
}

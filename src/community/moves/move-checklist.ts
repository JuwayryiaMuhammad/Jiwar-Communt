import type { DerivedMoveStep } from '../../core/moves/move-steps';

export const MOVE_DIRECTIONS = ['in', 'out'] as const;
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** Who ticks a manual step: the occupancy that moves, or the management. */
export type StepSide = 'resident' | 'management';

export interface ManualStep {
  key: string;
  side: StepSide;
}

/**
 * A move's checklist (ADR 0063), per direction: the manual steps, ticked
 * once each by their side, and the derived ones, read from the domains
 * that hold them (MoveSteps). A closed list: a new step is a code change,
 * and the CHECK on `unit_move_steps.step` only bounds its shape.
 */
export const MOVE_CHECKLIST: Record<
  MoveDirection,
  { manual: readonly ManualStep[]; derived: readonly DerivedMoveStep[] }
> = {
  in: {
    manual: [
      // The resident read the compound's moving guide.
      { key: 'guide_read', side: 'resident' },
      { key: 'keys_received', side: 'management' },
      { key: 'meters_read', side: 'management' },
    ],
    derived: ['move_permit', 'utilities_requested'],
  },
  out: {
    manual: [
      { key: 'meters_read', side: 'management' },
      { key: 'unit_inspected', side: 'management' },
      { key: 'keys_returned', side: 'management' },
    ],
    derived: ['move_permit', 'clearance_issued', 'deposits_settled'],
  },
};

export function manualStep(
  direction: MoveDirection,
  key: string,
): ManualStep | null {
  return MOVE_CHECKLIST[direction].manual.find((s) => s.key === key) ?? null;
}

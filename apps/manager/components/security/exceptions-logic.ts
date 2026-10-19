/**
 * The gate's field exceptions and settings (ADR 0056), as the API holds
 * their rules: what the management's inbox shows and may still answer,
 * the countdown to an exception's deadline, and the settings' bounds.
 * Plain TypeScript with no imports, so the tests run it as is.
 */

export const EXCEPTION_KINDS: Record<string, string> = {
  worker_outside_hours: 'Worker outside hours',
  visitor_without_pass: 'Visitor without a pass',
  unregistered_vehicle: 'Unregistered vehicle',
};

/** Whole seconds left before `deadline`, 0 once it passed. */
export function secondsLeft(deadline: string, now: number): number {
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "4:05", "0:09"; "1:02:03" past an hour. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface ExceptionLike {
  status: string;
  answerBy: string;
  entryUntil?: string | null;
  usedAt?: string | null;
}

/**
 * Where an exception stands for the inbox now: `answerable` while pending
 * and before its deadline; `lapsed` when pending past it (the server
 * expires it, lazily or by its sweep: no answer is taken); otherwise its
 * status.
 */
export function exceptionState(e: ExceptionLike, now: number): string {
  if (e.status !== 'pending') return e.status;
  return secondsLeft(e.answerBy, now) > 0 ? 'answerable' : 'lapsed';
}

/**
 * An approved exception's one entry: `used`, `open` until its window
 * ends, or `unused` after it. Null for any other status.
 */
export function entryState(e: ExceptionLike, now: number): 'used' | 'open' | 'unused' | null {
  if (e.status !== 'approved') return null;
  if (e.usedAt) return 'used';
  return e.entryUntil && secondsLeft(e.entryUntil, now) > 0 ? 'open' : 'unused';
}

/** Who or what asks to come in: a visitor's name, a worker's, a plate. */
export function exceptionSubject(e: {
  kind: string;
  visitorName?: string | null;
  workerName?: string | null;
  vehiclePlate?: string | null;
}): string {
  if (e.kind === 'unregistered_vehicle') return e.vehiclePlate ?? 'A vehicle (purged)';
  if (e.kind === 'worker_outside_hours') return e.workerName ?? 'A worker';
  return e.visitorName ?? 'A visitor (purged)';
}

/** The gate's settings, each with its bounds (the API's GATE_SETTING_LIMITS). */
export const GATE_SETTINGS = [
  { name: 'exceptionAnswerMinutes', label: 'Minutes to answer a field exception', min: 1, max: 60 },
  { name: 'exceptionEntryMinutes', label: 'Minutes an approved exception lets its entry in', min: 5, max: 120 },
  { name: 'visitExpectedMinutes', label: 'A visit’s expected minutes, when its pass says none', min: 15, max: 720, nullable: true },
  { name: 'geofenceExitMinutes', label: 'Minutes outside a patrol’s area before it is flagged', min: 1, max: 60 },
  { name: 'audioMaxSeconds', label: 'Longest sound recording, in seconds', min: 10, max: 600 },
  { name: 'videoMaxSeconds', label: 'Longest video recording, in seconds', min: 10, max: 300 },
  { name: 'audioMaxMb', label: 'Largest sound recording, in MB', min: 1, max: 20 },
  { name: 'videoMaxMb', label: 'Largest video recording, in MB', min: 1, max: 100 },
  { name: 'offlineSyncAlertMinutes', label: 'Minutes a gate device on shift may go unseen before you are told', min: 5, max: 240 },
] as const;

export type GateSettingName = (typeof GATE_SETTINGS)[number]['name'];
type NullableSetting = Extract<(typeof GATE_SETTINGS)[number], { nullable: true }>['name'];
/** The PATCH's body: numbers, and null only for a setting that may be off. */
export type GateSettingsChanges = { [K in GateSettingName]?: K extends NullableSetting ? number | null : number };
export type GateSettingsForm = Record<GateSettingName, string>;

/** The form's text for each value; an off nullable value is empty. */
export function settingsForm(values: Record<GateSettingName, number | null>): GateSettingsForm {
  return Object.fromEntries(GATE_SETTINGS.map((s) => [s.name, values[s.name] === null ? '' : String(values[s.name])])) as GateSettingsForm;
}

/** The names whose text is not a whole number within its bounds (empty: off, where allowed). */
export function settingsErrors(form: GateSettingsForm): GateSettingName[] {
  return GATE_SETTINGS.filter((s) => {
    const text = form[s.name].trim();
    if (text === '') return !('nullable' in s && s.nullable);
    if (!/^\d+$/.test(text)) return true;
    const n = Number(text);
    return n < s.min || n > s.max;
  }).map((s) => s.name);
}

/**
 * What changed, as the PATCH takes it: numbers, null for an off value.
 * Read after `settingsErrors` passed, so only a nullable setting is empty.
 */
export function settingsChanges(
  before: Record<GateSettingName, number | null>,
  form: GateSettingsForm,
): GateSettingsChanges {
  const out: Partial<Record<GateSettingName, number | null>> = {};
  for (const s of GATE_SETTINGS) {
    const text = form[s.name].trim();
    const value = text === '' ? null : Number(text);
    if (value !== before[s.name]) out[s.name] = value;
  }
  return out as GateSettingsChanges;
}

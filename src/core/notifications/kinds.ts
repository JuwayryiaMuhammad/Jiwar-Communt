/**
 * The notification catalog (ADR 0027), like the audit catalog: every kind a
 * domain may write is declared here with its priority, what it points at
 * and the params it carries. The inbox stores codes and params, never text;
 * the apps render them in the reader's language (ADR 0013).
 *
 * A param is `personal` when it names a person outside the recipient's
 * account (a visitor, a worker). Personal params are scrubbed when the data
 * they came from expires, and never hold a document, phone or code (a unit
 * test checks the names).
 */
export type NotificationPriority = 'normal' | 'critical';

export interface ParamSpec {
  personal?: boolean;
  optional?: boolean;
}

export interface KindSpec {
  priority: NotificationPriority;
  /** What `targetId` refers to; the apps open it. */
  target: string;
  params: Record<string, ParamSpec>;
}

export const NOTIFICATION_KINDS = {
  /** A guard asks the household whether to let someone in (ADR 0028). */
  'gate.approval_requested': {
    priority: 'critical',
    target: 'gate_approval_request',
    params: {
      unitCode: {},
      requestKind: {},
      partySize: {},
      gateName: {},
      visitorName: { personal: true, optional: true },
      workerName: { personal: true, optional: true },
    },
  },
  /** A household reversed an approval before the entry: stop them. */
  'gate.approval_reversed': {
    priority: 'critical',
    target: 'gate_approval_request',
    params: { unitCode: {}, requestKind: {} },
  },
  'worker.entered': {
    priority: 'normal',
    target: 'worker_engagement',
    params: {
      unitCode: {},
      gateName: {},
      workerName: { personal: true },
    },
  },
  'worker.exited': {
    priority: 'normal',
    target: 'worker_engagement',
    params: {
      unitCode: {},
      gateName: {},
      workerName: { personal: true },
    },
  },
} as const satisfies Record<string, KindSpec>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export type NotificationParams = Record<string, string | number>;

/** Every param name that is personal in at least one kind. */
export const PERSONAL_PARAMS: readonly string[] = [
  ...new Set(
    Object.values(NOTIFICATION_KINDS as Record<string, KindSpec>).flatMap((k) =>
      Object.entries(k.params)
        .filter(([, spec]) => spec.personal)
        .map(([name]) => name),
    ),
  ),
].sort();

/** Throws on an unknown kind, an unknown or missing param, or a bad value. */
export function checkNotification(
  kind: string,
  params: NotificationParams,
): KindSpec {
  const spec = (NOTIFICATION_KINDS as Record<string, KindSpec>)[kind];
  if (!spec) throw new Error(`Unknown notification kind ${kind}`);
  for (const [name, value] of Object.entries(params)) {
    if (!spec.params[name])
      throw new Error(`Notification ${kind} has no param ${name}`);
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new Error(`Notification ${kind} param ${name} must be a scalar`);
  }
  for (const [name, p] of Object.entries(spec.params)) {
    if (!p.optional && !(name in params))
      throw new Error(`Notification ${kind} needs param ${name}`);
  }
  return spec;
}

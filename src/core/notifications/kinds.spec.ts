import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFICATION_CATEGORIES } from '../preferences/categories';
import {
  checkNotification,
  NOTIFICATION_KINDS,
  PERSONAL_PARAMS,
  type KindSpec,
} from './kinds';

/**
 * Security (a new device, a new entry device), emergency tickets, staff
 * work (a ticket assigned to me, a gate approval request and its reversal),
 * and the deletion notices (its confirmation, reminder and delay).
 */
const CRITICAL_KINDS = [
  'account.deletion_delayed',
  'account.deletion_reminder',
  'account.deletion_requested',
  'account.new_device_login',
  'entry_credential.issued',
  'gate.approval_requested',
  'gate.approval_reversed',
  'ticket.assigned',
  'ticket.emergency',
  'ticket.sla_breached_emergency',
  'ticket.unassignable_emergency',
].sort();

describe('notification catalog', () => {
  const kinds = NOTIFICATION_KINDS as Record<string, KindSpec>;

  it('no param name looks like a document, phone, email or code', () => {
    const names = Object.values(kinds).flatMap((k) => Object.keys(k.params));
    const offenders = names.filter((n) =>
      /document|national|passport|phone|mobile|email|code$|otp|token|secret|password/i.test(
        n.replace(/^unitCode$/, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('kinds are dotted codes with a priority and a target', () => {
    for (const [kind, spec] of Object.entries(kinds)) {
      expect(kind).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(['normal', 'critical']).toContain(spec.priority);
      expect(spec.target).toMatch(/^[a-z_]+$/);
    }
  });

  it('every kind declares its delivery category and whether it is critical', () => {
    for (const [kind, spec] of Object.entries(kinds)) {
      expect([kind, NOTIFICATION_CATEGORIES.includes(spec.category)]).toEqual([
        kind,
        true,
      ]);
      expect([kind, typeof spec.critical]).toEqual([kind, 'boolean']);
    }
  });

  it('the critical kinds are exactly the approved list (ADR 0036)', () => {
    const critical = Object.entries(kinds)
      .filter(([, spec]) => spec.critical)
      .map(([kind]) => kind)
      .sort();
    expect(critical).toEqual(CRITICAL_KINDS);
  });

  it('personal params are the visitor and worker names', () => {
    expect(PERSONAL_PARAMS).toEqual(['visitorName', 'workerName']);
  });

  it('rejects unknown kinds, unknown or missing params and non-scalars', () => {
    expect(() => checkNotification('nope.kind', {})).toThrow(/Unknown/);
    const ok = {
      unitCode: 'A-1',
      gateName: 'Main',
      workerName: 'W',
    };
    expect(() => checkNotification('worker.entered', ok)).not.toThrow();
    expect(() =>
      checkNotification('worker.entered', { ...ok, phone: '+20100' }),
    ).toThrow(/no param phone/);
    expect(() =>
      checkNotification('worker.entered', { unitCode: 'A-1', gateName: 'G' }),
    ).toThrow(/needs param workerName/);
    expect(() =>
      checkNotification('worker.entered', {
        ...ok,
        unitCode: { nested: true } as unknown as string,
      }),
    ).toThrow(/scalar/);
  });

  it('every kind is written somewhere in src/ (like the audit catalog)', () => {
    const root = join(__dirname, '..', '..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return name.endsWith('.ts') &&
          !name.endsWith('.spec.ts') &&
          path !== join(__dirname, 'kinds.ts')
          ? [readFileSync(path, 'utf8')]
          : [];
      });
    const source = files(root).join('\n');
    const silent = Object.keys(kinds).filter(
      (kind) => !source.includes(`'${kind}'`),
    );
    expect(silent).toEqual([]);
  });
});

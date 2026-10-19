import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import * as split from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { newId } from '../../src/core/common/uuid';
import {
  entryAction,
  newDevice,
  offlineHelpers,
  type Who,
} from '../setup/offline';

/**
 * One scenario per catalog entry of ADR 0057 (ADR 0014): actor, target and
 * metadata — ids, codes and counts by value; never a key, a signature, a
 * label, a code, a plate nor a name.
 */
const covered = new Set<string>();

const LABEL = 'Audit-invisible device label 5730';

describe('Audit coverage — the gate offline (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const secrets: string[] = [LABEL];
  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    const text = leakText(found);
    for (const secret of secrets) expect(text).not.toContain(secret);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  it('gate_device.enrolled: whether a label was given, never the label nor the key', async () => {
    const d = await o.enrol(s.guard, s.c, undefined, { label: LABEL });
    secrets.push(d.publicKey);
    const row = await single('gate_device.enrolled', d.id);
    expect(row).toMatchObject(by(s.guard, 'gate_device'));
    expect(row.metadata).toEqual({ labelled: true });
  });

  it('gate_device.revoked: the reason code', async () => {
    const d = await o.enrol(s.guard, s.c);
    secrets.push(d.publicKey);
    await o.revokeRaw(s.manager, d.id, 'compromised').expect(200);
    const row = await single('gate_device.revoked', d.id);
    expect(row).toMatchObject(by(s.manager, 'gate_device'));
    expect(row.metadata).toEqual({ reasonCode: 'compromised' });
  });

  it('gate_offline.upload_rejected: why, by code; never the key nor the payload', async () => {
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    secrets.push(d.publicKey);
    await o
      .uploadRaw(
        s.guard,
        s.c,
        d,
        [entryAction(d, b, { type: 'visitor_pass', id: newId() })],
        {},
        newDevice(),
      )
      .expect(422);
    const row = await single('gate_offline.upload_rejected', d.id);
    expect(row).toMatchObject(by(s.guard, 'gate_device'));
    expect(row.metadata).toEqual({ reason: 'signature' });
  });

  it('gate_offline_flag.reviewed: the flag’s kind and the code', async () => {
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    await o.upload(s.guard, s.c, d, [
      entryAction(d, b, { type: 'visitor_pass', id: newId() }),
    ]);
    const [flag] = await o.flagsOf(s.c, d.id);
    await o
      .http(
        'post',
        `/staff/gate/offline/flags/${flag.id}/review`,
        s.manager.token,
        { reviewCode: 'confirmed' },
      )
      .expect(200);
    const row = await single('gate_offline_flag.reviewed', flag.id);
    expect(row).toMatchObject(by(s.manager, 'gate_offline_flag'));
    expect(row.metadata).toEqual({
      kind: 'action_rejected',
      reviewCode: 'confirmed',
    });
  });

  it('gate_offline_batch.reviewed: the decision and how many, by number', async () => {
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    await o.revokeRaw(s.manager, d.id).expect(200);
    const up = await o.upload(s.guard, s.c, d, [
      entryAction(d, b, { type: 'visitor_pass', id: newId() }),
    ]);
    await o
      .http(
        'post',
        `/staff/gate/offline/batches/${up.batchId}/review`,
        s.manager.token,
        { decision: 'reject' },
      )
      .expect(200);
    const row = await single('gate_offline_batch.reviewed', up.batchId);
    expect(row).toMatchObject(by(s.manager, 'gate_offline_batch'));
    expect(row.metadata).toEqual({
      decision: 'rejected',
      actions: 1,
      recorded: 0,
    });
  });

  describe('catalog completeness', () => {
    it('every entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      const elsewhere = Object.entries(split)
        .filter(([name]) => name !== 'OFFLINE_COVERAGE')
        .flatMap(([, list]) => list);
      for (const key of split.OFFLINE_COVERAGE) {
        expect(all).toContain(key);
        expect(elsewhere).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...split.OFFLINE_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all.filter((k) => /^(gate_device|gate_offline)[._]/.test(k)).sort(),
      ).toEqual([...split.OFFLINE_COVERAGE].sort());
    });
  });
});

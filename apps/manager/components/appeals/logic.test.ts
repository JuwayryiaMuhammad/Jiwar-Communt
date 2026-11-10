import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/money-appeals.ts';
import en from '../../messages/en/money-appeals.ts';
import {
  decisionLine,
  EFFECT_REASONS,
  EFFECTS,
  KINDS,
  kindText,
  needsSticker,
  STATUSES,
  subjectHref,
} from './logic.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);
// Values in a message are wrapped in direction isolates.
const plain = (s: string) => s.replace(/[⁨⁩]/g, '');

test('the four kinds and the fourteen reasons of ADR 0059 (ADR 0074 adds the deposit), each with its words', () => {
  assert.deepEqual([...KINDS], ['permit_rejection', 'vehicle_rejection', 'worker_rejection', 'neighbour_notice']);
  assert.equal(EFFECT_REASONS.length, 14);
  const keys = new Set(Object.keys(en));
  for (const k of KINDS) assert.ok(keys.has(`kind.${k}`), k);
  for (const s of STATUSES) assert.ok(keys.has(`status.${s}`), s);
  for (const e of EFFECTS) assert.ok(keys.has(`effect.${e}`), e);
  for (const r of EFFECT_REASONS) assert.ok(keys.has(`effectReason.${r}`), r);
  assert.equal(kindText(tEn, 'worker_rejection'), 'Rejected worker');
  assert.equal(kindText(tAr, 'worker_rejection'), 'عامل مرفوض');
  assert.equal(kindText(tEn, 'something_new'), 'something_new');
});

test('only a vehicle overturned asks for a sticker', () => {
  assert.equal(needsSticker('vehicle_rejection', 'overturned'), true);
  assert.equal(needsSticker('vehicle_rejection', 'upheld'), false);
  assert.equal(needsSticker('permit_rejection', 'overturned'), false);
});

test('an overturn left to follow up says which check refused it', () => {
  assert.equal(
    plain(decisionLine({ outcome: 'overturned', effect: 'follow_up', effectReason: 'unit_limit' }, tEn)),
    'Overturned · For the management to follow up: the unit is at its limit',
  );
  assert.equal(
    plain(decisionLine({ outcome: 'overturned', effect: 'follow_up', effectReason: 'unit_limit' }, tAr)),
    'أُلغي القرار · تتابعه الإدارة، والسبب: بلغت الوحدة الحد المسموح',
  );
  assert.equal(decisionLine({ outcome: 'overturned', effect: 'applied', effectReason: null }, tEn), 'Overturned · Applied: the normal approval passed');
  assert.equal(decisionLine({ outcome: 'upheld', effect: 'none', effectReason: null }, tEn), 'Upheld: the decision stands');
});

test('a permit opens on its page, a vehicle in the list; the rest nowhere', () => {
  assert.equal(subjectHref('permit_rejection', 'p1'), '/permits/p1');
  assert.equal(subjectHref('vehicle_rejection', 'v1'), '/vehicles');
  assert.equal(subjectHref('worker_rejection', 'w1'), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bidActions, bidBody, documentHref, documentRefusal, liveBid, sendableDocuments } from './bid.ts';

const sent = { id: 'b', submittedAt: '2026-11-09T10:00:00.000Z', withdrawnAt: null, sealed: true, amount: null };

test('an open tender takes a bid; one with a live bid, its withdrawal; anything else, nothing', () => {
  assert.deepEqual(bidActions({ status: 'open', bid: null }), ['bid']);
  assert.deepEqual(bidActions({ status: 'open', bid: sent }), ['withdraw']);
  assert.deepEqual(bidActions({ status: 'open', bid: { ...sent, withdrawnAt: '2026-11-09T11:00:00.000Z' } }), ['bid']);
  for (const status of ['closed', 'awarded', 'cancelled'] as const) {
    assert.deepEqual(bidActions({ status, bid: null }), []);
    assert.deepEqual(bidActions({ status, bid: sent }), []);
  }
  assert.equal(liveBid({ bid: sent }), true);
  assert.equal(liveBid({ bid: null }), false);
});

test('the bid body: an amount the API takes, days and a note only when given', () => {
  assert.deepEqual(bidBody({ amount: ' 125000.50 ', durationDays: '', note: '' }), { amount: '125000.50' });
  assert.deepEqual(bidBody({ amount: '90000', durationDays: '30', note: ' Within a month ' }), {
    amount: '90000',
    durationDays: 30,
    note: 'Within a month',
  });
  for (const amount of ['', '0', '0.00', '-5', '1,000', '12.345', '1e5', '1234567890'])
    assert.equal(bidBody({ amount, durationDays: '', note: '' }), null, amount);
  for (const durationDays of ['0', '3651', '2.5', 'ten', '-1'])
    assert.equal(bidBody({ amount: '100', durationDays, note: '' }), null, durationDays);
  assert.equal(bidBody({ amount: '100', durationDays: '', note: 'x'.repeat(2001) }), null);
  assert.deepEqual(bidBody({ amount: '100', durationDays: '', note: 'x'.repeat(2000) }), { amount: '100', note: 'x'.repeat(2000) });
});

test('a document opens only from an http(s) URL', () => {
  assert.equal(documentHref('https://r2.example/t/x?X-Amz-Signature=1'), 'https://r2.example/t/x?X-Amz-Signature=1');
  assert.equal(documentHref('http://127.0.0.1:9005/b/x'), 'http://127.0.0.1:9005/b/x');
  for (const url of [null, '', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) assert.equal(documentHref(url), null);
});

test('the bid carries the drafts that arrived; a file is checked before its upload starts', () => {
  const doc = (id: string, ready: boolean, sent: boolean) => ({ id, title: id, contentType: 'application/pdf', ready, sent });
  assert.deepEqual(sendableDocuments({ bidDocuments: [doc('a', true, false), doc('b', false, false), doc('c', true, true)] }), ['a']);
  assert.deepEqual(bidBody({ amount: '100', durationDays: '', note: '' }, ['a', 'd']), { amount: '100', fileIds: ['a', 'd'] });
  assert.deepEqual(bidBody({ amount: '100', durationDays: '', note: '' }, []), { amount: '100' });
  assert.equal(documentRefusal({ type: 'application/pdf', size: 1000 }), null);
  assert.equal(documentRefusal({ type: 'image/webp', size: 10 * 1024 * 1024 }), null);
  assert.equal(documentRefusal({ type: 'text/csv', size: 10 }), 'FILE_TYPE_NOT_ALLOWED');
  assert.equal(documentRefusal({ type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }), 'FILE_TOO_LARGE');
});

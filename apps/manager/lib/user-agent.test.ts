import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUserAgent } from './user-agent.ts';

test('a browser and its system are named', () => {
  assert.equal(
    describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'),
    'Chrome on Linux',
  );
  assert.equal(
    describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'),
    'Edge on Windows',
  );
  assert.equal(
    describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    'Safari on iOS',
  );
  assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox on macOS');
});

test('the mobile app and the unknown still read as something', () => {
  assert.equal(describeUserAgent('okhttp/4.12.0'), 'The mobile app');
  assert.equal(describeUserAgent('Dart/3.5 (dart:io)'), 'The mobile app');
  assert.equal(describeUserAgent('curl/8.5.0'), 'Unknown device');
  assert.equal(describeUserAgent(null), 'Unknown device');
});

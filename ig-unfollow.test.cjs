/*!
 * Tests for the pure logic in ig-unfollow.js.
 * Copyright (c) 2026 FIWB Solutions LLC. MIT licensed — see LICENSE.
 * Author: Joshua Gonzales
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _pure, CONFIG } = require('./ig-unfollow.js');
const { getCookie, skipReason, buildPlan, detectCheckpoint, isThrottleMessage, buildHeaders } = _pure;

const user = (pk, username, extra) =>
  Object.assign({ pk: String(pk), username, full_name: '', is_verified: false }, extra);

const baseConfig = {
  WHITELIST: [], SKIP_VERIFIED: true,
  CHECK_FOLLOWER_COUNT: false, MIN_FOLLOWERS_TO_KEEP: 10000
};

// ---------------------------------------------------------------------------
test('skipReason', async (t) => {
  await t.test('spares whitelisted users case-insensitively', () => {
    const cfg = Object.assign({}, baseConfig, { WHITELIST: ['BestFriend'] });
    assert.equal(skipReason(user(1, 'bestfriend'), cfg), 'whitelisted');
    assert.equal(skipReason(user(2, 'BESTFRIEND'), cfg), 'whitelisted');
  });

  await t.test('spares verified accounts without any extra request', () => {
    assert.equal(skipReason(user(1, 'celeb', { is_verified: true }), baseConfig), 'verified');
  });

  await t.test('allows an ordinary account', () => {
    assert.equal(skipReason(user(1, 'nobody'), baseConfig), null);
  });

  await t.test('ignores follower count entirely unless the lookup is enabled', () => {
    assert.equal(skipReason(user(1, 'x', { follower_count: 999999 }), baseConfig), null);
  });

  await t.test('honours the follower threshold when the lookup is enabled', () => {
    const cfg = Object.assign({}, baseConfig, { CHECK_FOLLOWER_COUNT: true });
    assert.match(skipReason(user(1, 'x', { follower_count: 20000 }), cfg), /20000 followers/);
    assert.equal(skipReason(user(1, 'x', { follower_count: 5 }), cfg), null);
  });

  await t.test('spares a user whose count could not be read, when the lookup is enabled', () => {
    const cfg = Object.assign({}, baseConfig, { CHECK_FOLLOWER_COUNT: true });
    assert.equal(skipReason(user(1, 'x', { follower_count: null }), cfg), 'follower count unknown');
  });

  await t.test('keeps verified users spared even with the lookup on', () => {
    const cfg = Object.assign({}, baseConfig, { CHECK_FOLLOWER_COUNT: true });
    assert.equal(skipReason(user(1, 'c', { is_verified: true, follower_count: 3 }), cfg), 'verified');
  });
});

// ---------------------------------------------------------------------------
test('buildPlan', async (t) => {
  await t.test('separates targets, spared users, and completed ones', () => {
    const cfg = Object.assign({}, baseConfig, { WHITELIST: ['keeper'] });
    const plan = buildPlan(
      [user(1, 'target'), user(2, 'keeper'), user(3, 'celeb', { is_verified: true }), user(4, 'olddone')],
      ['4'],
      cfg
    );
    assert.deepEqual(plan.willUnfollow.map((u) => u.username), ['target']);
    assert.deepEqual(plan.skipped.map((s) => s.reason).sort(), ['verified', 'whitelisted']);
    assert.deepEqual(plan.alreadyDone.map((u) => u.username), ['olddone']);
  });

  await t.test('never re-unfollows someone already processed', () => {
    const plan = buildPlan([user(1, 'a')], ['1'], baseConfig);
    assert.equal(plan.willUnfollow.length, 0);
    assert.equal(plan.alreadyDone.length, 1);
  });

  await t.test('matches completed users by pk, not username', () => {
    const plan = buildPlan([user(1, 'renamed')], ['1'], baseConfig);
    assert.equal(plan.alreadyDone.length, 1);
  });

  await t.test('handles empty input', () => {
    const plan = buildPlan([], [], baseConfig);
    assert.deepEqual(plan, { willUnfollow: [], skipped: [], alreadyDone: [] });
    assert.deepEqual(buildPlan(null, null, baseConfig).willUnfollow, []);
  });
});

// ---------------------------------------------------------------------------
test('buildHeaders', async (t) => {
  await t.test('always uses the live CSRF token, never a replayed one', () => {
    const h = buildHeaders({ 'x-csrftoken': 'STALE' }, 'FRESH');
    assert.equal(h['x-csrftoken'], 'FRESH');
  });

  await t.test('replays captured client headers', () => {
    const h = buildHeaders({ 'x-ig-www-claim': 'hmac.LIVE', 'x-asbd-id': '129477' }, 'tok');
    assert.equal(h['x-ig-www-claim'], 'hmac.LIVE');
    assert.equal(h['x-asbd-id'], '129477');
  });

  await t.test('falls back to a default app id when none was captured', () => {
    assert.equal(buildHeaders(null, 'tok')['x-ig-app-id'], '936619743392459');
  });

  await t.test('keeps a captured app id over the default', () => {
    assert.equal(buildHeaders({ 'x-ig-app-id': '111' }, 'tok')['x-ig-app-id'], '111');
  });

  await t.test('lowercases header names and sets the form content type', () => {
    const h = buildHeaders({ 'X-IG-WWW-Claim': 'hmac.X' }, 'tok');
    assert.equal(h['x-ig-www-claim'], 'hmac.X');
    assert.equal(h['content-type'], 'application/x-www-form-urlencoded');
  });

  await t.test('drops empty captured values', () => {
    assert.equal(buildHeaders({ 'x-ig-www-claim': '' }, 'tok')['x-ig-www-claim'], undefined);
  });
});

// ---------------------------------------------------------------------------
test('failure classification', async (t) => {
  const REAL_LOCK = '{"message":"checkpoint_required","checkpoint_url":"https://www.instagram.com/challenge/","lock":true,"status":"fail"}';

  await t.test('detects the real lock body', () => {
    const cp = detectCheckpoint(REAL_LOCK);
    assert.equal(cp.locked, true);
    assert.equal(cp.url, 'https://www.instagram.com/challenge/');
  });

  await t.test('a checkpoint is never classified as a throttle', () => {
    assert.ok(detectCheckpoint(REAL_LOCK));
    assert.equal(isThrottleMessage('checkpoint_required'), false);
  });

  await t.test('a throttle is never classified as a checkpoint', () => {
    const body = '{"message":"Please wait a few minutes before you try again."}';
    assert.equal(detectCheckpoint(body), null);
    assert.equal(isThrottleMessage('Please wait a few minutes before you try again.'), true);
  });

  await t.test('returns null for unparseable bodies', () => {
    assert.equal(detectCheckpoint('<html></html>'), null);
    assert.equal(detectCheckpoint(''), null);
  });
});

// ---------------------------------------------------------------------------
test('getCookie', async (t) => {
  await t.test('reads a token from the jar', () => {
    assert.equal(getCookie('csrftoken', 'a=1; csrftoken=abc; ds_user_id=42'), 'abc');
  });

  await t.test('returns null when missing or empty', () => {
    assert.equal(getCookie('csrftoken', 'a=1'), null);
    assert.equal(getCookie('csrftoken', 'csrftoken='), null);
  });
});

// ---------------------------------------------------------------------------
test('safety defaults', async (t) => {
  await t.test('ships with DRY_RUN on', () => {
    assert.equal(CONFIG.DRY_RUN, true);
  });

  await t.test('ships with no target account, forcing an explicit choice', () => {
    // A write script must never default to "whoever is logged in".
    assert.equal(CONFIG.TARGET_USERNAME, '');
  });

  await t.test('skips verified accounts by default', () => {
    assert.equal(CONFIG.SKIP_VERIFIED, true);
  });

  await t.test('leaves the extra follower-count lookup off by default', () => {
    assert.equal(CONFIG.CHECK_FOLLOWER_COUNT, false);
  });

  await t.test('caps a run conservatively and paces it in minutes', () => {
    assert.ok(CONFIG.MAX_UNFOLLOWS_PER_RUN <= 20);
    assert.ok(CONFIG.DELAY_MS[0] >= 30000);
  });

  await t.test('does not auto-run outside a browser', () => {
    assert.equal(typeof window, 'undefined');
  });
});

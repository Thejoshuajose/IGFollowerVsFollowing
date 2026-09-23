/*!
 * Tests for the pure logic in ig-follow-check.js.
 * Copyright (c) 2026 FIWB Solutions LLC. MIT licensed — see LICENSE.
 * Author: Joshua Gonzales
 *
 * Run: node --test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _pure, CONFIG } = require('./ig-follow-check.js');
const {
  getCookie, normalizeUser, diffFollows, skipReason, toCSV, csvEscape, backoffMs,
  extractIgMessage, isThrottleMessage, detectCheckpoint, annotate
} = _pure;

// The exact body Instagram returned when it locked the account mid-pagination.
const REAL_CHECKPOINT_BODY = JSON.stringify({
  message: 'checkpoint_required',
  checkpoint_url: 'https://www.instagram.com/challenge/?next=/api/v1/friendships/1234567890/followers/',
  lock: true,
  flow_render_type: 0,
  status: 'fail'
});

const user = (pk, username, extra) =>
  Object.assign({ pk: String(pk), username, full_name: '', is_verified: false, is_private: false }, extra);

// ---------------------------------------------------------------------------
test('getCookie', async (t) => {
  await t.test('reads the first cookie', () => {
    assert.equal(getCookie('csrftoken', 'csrftoken=abc123; ds_user_id=42'), 'abc123');
  });

  await t.test('reads a middle and a trailing cookie', () => {
    const jar = 'a=1; csrftoken=abc; ds_user_id=42';
    assert.equal(getCookie('csrftoken', jar), 'abc');
    assert.equal(getCookie('ds_user_id', jar), '42');
  });

  await t.test('returns null when absent, and does not match a suffix', () => {
    assert.equal(getCookie('csrftoken', 'ds_user_id=42'), null);
    assert.equal(getCookie('token', 'csrftoken=abc'), null);
  });

  await t.test('returns null for an empty jar or an empty value', () => {
    assert.equal(getCookie('csrftoken', ''), null);
    assert.equal(getCookie('csrftoken', 'csrftoken=; x=1'), null);
  });

  await t.test('percent-decodes, and survives malformed encoding', () => {
    assert.equal(getCookie('x', 'x=a%20b'), 'a b');
    assert.equal(getCookie('x', 'x=100%'), '100%');
  });
});

// ---------------------------------------------------------------------------
test('normalizeUser', async (t) => {
  await t.test('coerces a numeric pk to a string', () => {
    assert.equal(normalizeUser({ pk: 12345, username: 'a' }).pk, '12345');
  });

  await t.test('rejects entries without a pk', () => {
    assert.equal(normalizeUser(null), null);
    assert.equal(normalizeUser({ username: 'a' }), null);
  });

  await t.test('keeps pk 0 rather than treating it as missing', () => {
    assert.equal(normalizeUser({ pk: 0, username: 'a' }).pk, '0');
  });

  await t.test('defaults missing optional fields', () => {
    const u = normalizeUser({ pk: '1', username: 'a' });
    assert.deepEqual(u, { pk: '1', username: 'a', full_name: '', is_verified: false, is_private: false });
  });
});

// ---------------------------------------------------------------------------
test('diffFollows', async (t) => {
  await t.test('finds accounts that do not follow back', () => {
    const following = [user(1, 'alice'), user(2, 'bob'), user(3, 'carol')];
    const followers = [user(2, 'bob')];
    const { notFollowingBack } = diffFollows(following, followers);
    assert.deepEqual(notFollowingBack.map((u) => u.username), ['alice', 'carol']);
  });

  await t.test('finds followers you do not follow back', () => {
    const following = [user(1, 'alice')];
    const followers = [user(1, 'alice'), user(9, 'dave')];
    const { fansYouDontFollow } = diffFollows(following, followers);
    assert.deepEqual(fansYouDontFollow.map((u) => u.username), ['dave']);
  });

  await t.test('matches on pk, not username (handles a rename)', () => {
    const { notFollowingBack } = diffFollows([user(1, 'alice_new')], [user(1, 'alice_old')]);
    assert.deepEqual(notFollowingBack, []);
  });

  await t.test('compares pk as a string across numeric and string inputs', () => {
    const { notFollowingBack } = diffFollows([normalizeUser({ pk: 7, username: 'x' })], [normalizeUser({ pk: '7', username: 'x' })]);
    assert.deepEqual(notFollowingBack, []);
  });

  await t.test('handles empty and missing lists', () => {
    assert.deepEqual(diffFollows([], []), { notFollowingBack: [], fansYouDontFollow: [] });
    assert.deepEqual(diffFollows(undefined, undefined), { notFollowingBack: [], fansYouDontFollow: [] });
    assert.deepEqual(diffFollows([user(1, 'a')], []).notFollowingBack.length, 1);
  });

  await t.test('is mutual when both lists match entirely', () => {
    const both = [user(1, 'a'), user(2, 'b')];
    const d = diffFollows(both, both.slice().reverse());
    assert.deepEqual(d.notFollowingBack, []);
    assert.deepEqual(d.fansYouDontFollow, []);
  });
});

// ---------------------------------------------------------------------------
test('skipReason', async (t) => {
  const cfg = { MIN_FOLLOWERS_TO_KEEP: 10000, WHITELIST: ['BestFriend'] };

  await t.test('spares whitelisted users case-insensitively', () => {
    assert.equal(skipReason({ username: 'bestfriend', follower_count: 3 }, cfg), 'whitelisted');
    assert.equal(skipReason({ username: 'BESTFRIEND', follower_count: 3 }, cfg), 'whitelisted');
  });

  await t.test('spares accounts at or above the threshold', () => {
    assert.match(skipReason({ username: 'x', follower_count: 10000 }, cfg), /10000 followers/);
    assert.match(skipReason({ username: 'x', follower_count: 50000 }, cfg), /followers/);
  });

  await t.test('allows accounts below the threshold', () => {
    assert.equal(skipReason({ username: 'x', follower_count: 9999 }, cfg), null);
    assert.equal(skipReason({ username: 'x', follower_count: 0 }, cfg), null);
  });

  await t.test('spares a user whose follower count could not be read', () => {
    assert.equal(skipReason({ username: 'x', follower_count: null }, cfg), 'follower count unknown');
    assert.equal(skipReason({ username: 'x' }, cfg), 'follower count unknown');
  });

  await t.test('falls back to the module CONFIG when none is passed', () => {
    assert.equal(skipReason({ username: 'x', follower_count: CONFIG.MIN_FOLLOWERS_TO_KEEP + 1 }, undefined) !== null, true);
  });
});

// ---------------------------------------------------------------------------
test('CSV output', async (t) => {
  await t.test('quotes every field', () => {
    assert.equal(csvEscape('plain'), '"plain"');
  });

  await t.test('doubles embedded quotes and preserves commas and newlines', () => {
    assert.equal(csvEscape('say "hi", ok\nnext'), '"say ""hi"", ok\nnext"');
  });

  await t.test('renders null and undefined as empty', () => {
    assert.equal(csvEscape(null), '""');
    assert.equal(csvEscape(undefined), '""');
  });

  await t.test('emits a header plus one CRLF-terminated row per user', () => {
    const csv = toCSV([user(1, 'alice', { full_name: 'Alice A' })]);
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '"username","full_name","pk","is_verified","is_private"');
    assert.equal(lines[1], '"alice","Alice A","1","false","false"');
  });

  await t.test('emits only the header for no rows', () => {
    assert.equal(toCSV([]).split('\r\n').length, 1);
    assert.equal(toCSV(undefined).split('\r\n').length, 1);
  });

  await t.test('a username that looks like a formula stays inside one field', () => {
    const csv = toCSV([user(1, '=cmd|"/c calc"!A1')]);
    assert.equal(csv.split('\r\n').length, 2);
    assert.ok(csv.includes('"=cmd|""/c calc""!A1"'));
  });
});

// ---------------------------------------------------------------------------
test('backoffMs', async (t) => {
  await t.test('honors a sane Retry-After header', () => {
    assert.equal(backoffMs(0, '120'), 120000);
  });

  await t.test('ignores a junk or non-positive Retry-After', () => {
    assert.equal(backoffMs(0, 'soon'), 60000);
    assert.equal(backoffMs(0, '0'), 60000);
    assert.equal(backoffMs(0, '-5'), 60000);
    assert.equal(backoffMs(0, null), 60000);
  });

  await t.test('grows exponentially and caps at 15 minutes', () => {
    assert.equal(backoffMs(1), 120000);
    assert.equal(backoffMs(2), 240000);
    assert.equal(backoffMs(10), 15 * 60 * 1000);
  });

  await t.test('caps an absurd Retry-After at one hour', () => {
    assert.equal(backoffMs(0, '99999'), 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
test('extractIgMessage', async (t) => {
  await t.test('pulls the message field', () => {
    assert.equal(
      extractIgMessage('{"message":"Please wait a few minutes before you try again.","status":"fail"}'),
      'Please wait a few minutes before you try again.'
    );
  });

  await t.test('falls back through the other reason fields', () => {
    assert.equal(extractIgMessage('{"error_title":"Oops"}'), 'Oops');
    assert.equal(extractIgMessage('{"feedback_message":"blocked"}'), 'blocked');
    assert.equal(extractIgMessage('{"error_message":"bad cursor"}'), 'bad cursor');
  });

  await t.test('stringifies a structured message rather than dropping it', () => {
    assert.equal(extractIgMessage('{"message":{"errors":["bad max_id"]}}'), '{"errors":["bad max_id"]}');
  });

  await t.test('returns empty for an HTML challenge page or truncated JSON', () => {
    assert.equal(extractIgMessage('<!DOCTYPE html><html>login</html>'), '');
    assert.equal(extractIgMessage('{"message":"cut off'), '');
    assert.equal(extractIgMessage(''), '');
    assert.equal(extractIgMessage(null), '');
  });

  await t.test('returns empty when JSON carries no reason field', () => {
    assert.equal(extractIgMessage('{"status":"fail"}'), '');
  });
});

// ---------------------------------------------------------------------------
test('isThrottleMessage', async (t) => {
  await t.test('recognizes the soft-block wording Instagram returns as 400', () => {
    assert.equal(isThrottleMessage('Please wait a few minutes before you try again.'), true);
    assert.equal(isThrottleMessage('Try again later'), true);
    assert.equal(isThrottleMessage('Too many requests'), true);
    assert.equal(isThrottleMessage('Slow down'), true);
    assert.equal(isThrottleMessage('rate limit exceeded'), true);
  });

  await t.test('does not misclassify an unrelated failure as a throttle', () => {
    assert.equal(isThrottleMessage('checkpoint_required'), false);
    assert.equal(isThrottleMessage('invalid max_id'), false);
    assert.equal(isThrottleMessage('User not found'), false);
  });

  await t.test('handles empty input', () => {
    assert.equal(isThrottleMessage(''), false);
    assert.equal(isThrottleMessage(null), false);
    assert.equal(isThrottleMessage(undefined), false);
  });
});

// ---------------------------------------------------------------------------
test('detectCheckpoint', async (t) => {
  await t.test('detects the real lock response, with url and lock flag', () => {
    const cp = detectCheckpoint(REAL_CHECKPOINT_BODY);
    assert.ok(cp);
    assert.equal(cp.locked, true);
    assert.match(cp.url, /^https:\/\/www\.instagram\.com\/challenge\//);
  });

  await t.test('detects a checkpoint with no url given', () => {
    const cp = detectCheckpoint('{"message":"checkpoint_required","status":"fail"}');
    assert.ok(cp);
    assert.equal(cp.url, null);
    assert.equal(cp.locked, false);
  });

  await t.test('detects challenge_required as well', () => {
    assert.ok(detectCheckpoint('{"message":"challenge_required","status":"fail"}'));
  });

  await t.test('detects a nested challenge object', () => {
    const cp = detectCheckpoint('{"challenge":{"url":"https://www.instagram.com/challenge/x"}}');
    assert.equal(cp.url, 'https://www.instagram.com/challenge/x');
  });

  await t.test('returns null for a throttle, so the two never get confused', () => {
    assert.equal(detectCheckpoint('{"message":"Please wait a few minutes before you try again."}'), null);
  });

  await t.test('returns null for unrelated or unparseable bodies', () => {
    assert.equal(detectCheckpoint('{"status":"fail"}'), null);
    assert.equal(detectCheckpoint('<html>login</html>'), null);
    assert.equal(detectCheckpoint(''), null);
    assert.equal(detectCheckpoint(null), null);
  });

  await t.test('does not fire on a username that merely mentions a checkpoint', () => {
    assert.equal(detectCheckpoint('{"message":"user checkpoint_required_fan not found"}'), null);
  });
});

// ---------------------------------------------------------------------------
test('checkpoint and throttle classification are mutually exclusive', async (t) => {
  await t.test('the real lock body is a checkpoint and NOT a throttle', () => {
    assert.ok(detectCheckpoint(REAL_CHECKPOINT_BODY));
    assert.equal(isThrottleMessage(extractIgMessage(REAL_CHECKPOINT_BODY)), false);
  });

  await t.test('a wait message is a throttle and NOT a checkpoint', () => {
    const body = '{"message":"Please wait a few minutes before you try again."}';
    assert.equal(detectCheckpoint(body), null);
    assert.equal(isThrottleMessage(extractIgMessage(body)), true);
  });
});

// ---------------------------------------------------------------------------
test('annotate', async (t) => {
  await t.test('attaches status and body without losing the message', () => {
    const err = annotate(new Error('boom'), 400, '{"message":"x"}');
    assert.equal(err.message, 'boom');
    assert.equal(err.status, 400);
    assert.equal(err.body, '{"message":"x"}');
  });

  await t.test('returns the same error instance', () => {
    const original = new Error('boom');
    assert.equal(annotate(original, 400, ''), original);
  });
});

// ---------------------------------------------------------------------------
test('safety defaults', async (t) => {
  await t.test('ships with DRY_RUN on', () => {
    assert.equal(CONFIG.DRY_RUN, true);
  });

  await t.test('ships with no hardcoded target account', () => {
    assert.equal(CONFIG.TARGET_USERNAME, '');
  });

  await t.test('caps unfollows per run', () => {
    assert.ok(CONFIG.MAX_UNFOLLOWS_PER_RUN > 0 && CONFIG.MAX_UNFOLLOWS_PER_RUN <= 100);
  });

  await t.test('does not auto-run outside a browser', () => {
    assert.equal(typeof window, 'undefined');
  });
});

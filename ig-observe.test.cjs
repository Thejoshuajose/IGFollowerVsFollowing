/*!
 * Tests for the pure logic in ig-observe.js.
 * Copyright (c) 2026 FIWB Solutions LLC. MIT licensed — see LICENSE.
 * Author: Joshua Gonzales
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _pure } = require('./ig-observe.js');
const {
  parseListUrl, normalizeUser, extractUsers, mergeUsers, diffFollows,
  parseCount, stripCountLabel, pickClientHeaders, toCSV, isCheckpointPayload
} = _pure;

const user = (pk, username, extra) =>
  Object.assign({ pk: String(pk), username, full_name: '', is_verified: false, is_private: false }, extra);

// ---------------------------------------------------------------------------
test('parseListUrl', async (t) => {
  await t.test('matches a followers list with a query string', () => {
    assert.deepEqual(
      parseListUrl('https://www.instagram.com/api/v1/friendships/1234567890/followers/?count=12'),
      { userId: '1234567890', which: 'followers' }
    );
  });

  await t.test('matches a following list and a relative URL', () => {
    assert.deepEqual(parseListUrl('/api/v1/friendships/42/following/'), { userId: '42', which: 'following' });
  });

  await t.test('ignores endpoints that are not friendship lists', () => {
    assert.equal(parseListUrl('https://www.instagram.com/api/v1/users/42/info/'), null);
    assert.equal(parseListUrl('/api/v1/friendships/destroy/42/'), null);
    assert.equal(parseListUrl('/api/v1/friendships/show/42/'), null);
    assert.equal(parseListUrl('/graphql/query'), null);
  });

  await t.test('ignores empty and non-string input', () => {
    assert.equal(parseListUrl(''), null);
    assert.equal(parseListUrl(null), null);
    assert.equal(parseListUrl(undefined), null);
  });
});

// ---------------------------------------------------------------------------
test('extractUsers', async (t) => {
  await t.test('reads the users array and normalizes pk to a string', () => {
    const users = extractUsers({ users: [{ pk: 1, username: 'a' }, { pk: '2', username: 'b' }] });
    assert.deepEqual(users.map((u) => u.pk), ['1', '2']);
  });

  await t.test('drops malformed entries instead of throwing', () => {
    const users = extractUsers({ users: [{ pk: 1, username: 'a' }, null, { username: 'nopk' }] });
    assert.equal(users.length, 1);
  });

  await t.test('returns empty for payloads with no user list', () => {
    assert.deepEqual(extractUsers({}), []);
    assert.deepEqual(extractUsers(null), []);
    assert.deepEqual(extractUsers({ users: 'not-an-array' }), []);
  });

  await t.test('preserves the verified flag the unfollow script relies on', () => {
    assert.equal(extractUsers({ users: [{ pk: 1, username: 'a', is_verified: true }] })[0].is_verified, true);
  });
});

// ---------------------------------------------------------------------------
test('mergeUsers', async (t) => {
  await t.test('counts only genuinely new users', () => {
    const store = {};
    assert.equal(mergeUsers(store, [user(1, 'a'), user(2, 'b')]), 2);
    assert.equal(mergeUsers(store, [user(2, 'b'), user(3, 'c')]), 1);
    assert.equal(Object.keys(store).length, 3);
  });

  await t.test('refreshes an existing record after a username change', () => {
    const store = {};
    mergeUsers(store, [user(1, 'old_name')]);
    mergeUsers(store, [user(1, 'new_name')]);
    assert.equal(store['1'].username, 'new_name');
    assert.equal(Object.keys(store).length, 1);
  });

  await t.test('tolerates empty input', () => {
    const store = {};
    assert.equal(mergeUsers(store, []), 0);
    assert.equal(mergeUsers(store, null), 0);
  });
});

// ---------------------------------------------------------------------------
test('parseCount and stripCountLabel', async (t) => {
  await t.test('parses a plain and comma-grouped number', () => {
    assert.equal(parseCount('1450'), 1450);
    assert.equal(parseCount('1,450'), 1450);
  });

  await t.test('expands magnitude suffixes', () => {
    assert.equal(parseCount('1.4K'), 1400);
    assert.equal(parseCount('2M'), 2000000);
    assert.equal(parseCount('3k'), 3000);
  });

  await t.test('strips a trailing word label but never a magnitude suffix', () => {
    assert.equal(stripCountLabel('1,450 followers'), '1,450');
    assert.equal(stripCountLabel('1.4K followers'), '1.4K');
    assert.equal(stripCountLabel('892 following'), '892');
    // regression: a bare "1.4K" must not lose its K
    assert.equal(stripCountLabel('1.4K'), '1.4K');
  });

  await t.test('round-trips label stripping into parsing', () => {
    assert.equal(parseCount(stripCountLabel('1.4K followers')), 1400);
    assert.equal(parseCount(stripCountLabel('1.4K')), 1400);
    assert.equal(parseCount(stripCountLabel('1,450 followers')), 1450);
  });

  await t.test('returns null for unparseable input', () => {
    assert.equal(parseCount('followers'), null);
    assert.equal(parseCount(''), null);
    assert.equal(parseCount(null), null);
  });
});

// ---------------------------------------------------------------------------
test('pickClientHeaders', async (t) => {
  await t.test('captures the headers worth replaying from a plain object', () => {
    const picked = pickClientHeaders({
      'X-IG-App-ID': '936619743392459',
      'x-ig-www-claim': 'hmac.LIVE',
      'x-asbd-id': '129477',
      'cookie': 'secret',
      'user-agent': 'irrelevant'
    });
    assert.equal(picked['x-ig-app-id'], '936619743392459');
    assert.equal(picked['x-ig-www-claim'], 'hmac.LIVE');
    assert.equal(picked['x-asbd-id'], '129477');
  });

  await t.test('never captures cookies or other non-listed headers', () => {
    const picked = pickClientHeaders({ cookie: 'sessionid=secret', authorization: 'Bearer x' });
    assert.deepEqual(picked, {});
  });

  await t.test('reads from a Headers-like object via get()', () => {
    const headers = new Map([['x-ig-www-claim', 'hmac.ABC']]);
    const picked = pickClientHeaders({ get: (n) => headers.get(n) || null });
    assert.equal(picked['x-ig-www-claim'], 'hmac.ABC');
  });

  await t.test('returns empty for missing or empty input', () => {
    assert.deepEqual(pickClientHeaders(null), {});
    assert.deepEqual(pickClientHeaders({}), {});
  });

  await t.test('drops empty-string values rather than storing them', () => {
    assert.deepEqual(pickClientHeaders({ 'x-ig-www-claim': '' }), {});
  });
});

// ---------------------------------------------------------------------------
test('isCheckpointPayload', async (t) => {
  await t.test('fires on a passively observed checkpoint', () => {
    assert.equal(isCheckpointPayload({ message: 'checkpoint_required', lock: true }), true);
    assert.equal(isCheckpointPayload({ checkpoint_url: 'https://www.instagram.com/challenge/' }), true);
  });

  await t.test('does not fire on a normal list payload', () => {
    assert.equal(isCheckpointPayload({ users: [], status: 'ok' }), false);
    assert.equal(isCheckpointPayload(null), false);
  });
});

// ---------------------------------------------------------------------------
test('diffFollows', async (t) => {
  await t.test('finds who does not follow back, matching on pk', () => {
    const d = diffFollows([user(1, 'alice'), user(2, 'bob')], [user(2, 'bob')]);
    assert.deepEqual(d.notFollowingBack.map((u) => u.username), ['alice']);
    assert.deepEqual(d.fansYouDontFollow, []);
  });

  await t.test('is empty both ways when the lists match', () => {
    const both = [user(1, 'a')];
    const d = diffFollows(both, both);
    assert.deepEqual(d.notFollowingBack, []);
    assert.deepEqual(d.fansYouDontFollow, []);
  });

  await t.test('an incomplete followers list inflates notFollowingBack (documented hazard)', () => {
    // This is exactly why diff() warns when capture is short of the target count.
    const d = diffFollows([user(1, 'a'), user(2, 'b')], []);
    assert.equal(d.notFollowingBack.length, 2);
  });
});

// ---------------------------------------------------------------------------
test('toCSV', async (t) => {
  await t.test('quotes fields and doubles embedded quotes', () => {
    const csv = toCSV([user(1, 'a"b')]);
    assert.ok(csv.includes('"a""b"'));
  });

  await t.test('emits only a header for no rows', () => {
    assert.equal(toCSV([]).split('\r\n').length, 1);
  });
});

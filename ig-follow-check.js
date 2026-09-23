/*!
 * ig-follow-check.js — who you follow that doesn't follow you back.
 *
 * Copyright (c) 2026 FIWB Solutions LLC. MIT licensed — see LICENSE.
 * Author: Joshua Gonzales
 *
 * Usage: open https://www.instagram.com/ logged in as the TARGET_USERNAME below,
 * open DevTools (F12) -> Console, paste this whole file, press Enter.
 *
 * Defaults to DRY_RUN (report only). Nothing is unfollowed unless you flip the
 * flag and call IGCheck.unfollowAll() yourself.
 */
;(function (root) {
  'use strict';

  var CONFIG = {
    // Guard rail: set this to your handle and the script aborts unless the logged-in
    // session IS that account. Left empty, it reads whichever account is logged in.
    TARGET_USERNAME: '',

    // true  = report only, never sends an unfollow request.
    // false = IGCheck.unfollowAll() is armed (still must be called explicitly).
    DRY_RUN: true,

    // Accounts with at least this many followers are never unfollowed.
    MIN_FOLLOWERS_TO_KEEP: 10000,

    // Usernames never unfollowed, regardless of follower count. Lowercase.
    WHITELIST: [],

    PAGE_SIZE: 50,              // users per list request
    MAX_PAGES: 400,             // hard stop, guards against a pagination loop
    PAGE_DELAY_MS: [1500, 3500],   // random pause between list pages
    UNFOLLOW_DELAY_MS: [20000, 45000], // random pause between unfollows
    UNFOLLOW_BATCH_SIZE: 10,    // pause longer after this many unfollows
    UNFOLLOW_BATCH_PAUSE_MS: 12 * 60 * 1000,
    MAX_UNFOLLOWS_PER_RUN: 50,  // ceiling per invocation
    MAX_RETRIES: 4
  };

  var API_ORIGIN = 'https://www.instagram.com';
  var IG_APP_ID = '936619743392459';

  // ---------------------------------------------------------------------------
  // Pure helpers (unit-tested in ig-follow-check.test.cjs)
  // ---------------------------------------------------------------------------

  /** Read a cookie by name. `cookieString` is injectable for testing. */
  function getCookie(name, cookieString) {
    var raw = typeof cookieString === 'string'
      ? cookieString
      : (typeof document !== 'undefined' ? document.cookie : '');
    var parts = ('; ' + raw).split('; ' + name + '=');
    if (parts.length < 2) return null;
    var value = parts.pop().split(';').shift();
    if (value === '') return null;
    try {
      return decodeURIComponent(value);
    } catch (err) {
      return value; // malformed percent-encoding: hand back the raw value
    }
  }

  /** Normalize one user object from an Instagram friendships list response. */
  function normalizeUser(u) {
    if (!u || u.pk == null) return null;
    return {
      pk: String(u.pk),
      username: String(u.username || ''),
      full_name: String(u.full_name || ''),
      is_verified: Boolean(u.is_verified),
      is_private: Boolean(u.is_private)
    };
  }

  /** Split two user lists into the two interesting sets. O(n+m). */
  function diffFollows(following, followers) {
    var followerPks = new Set((followers || []).map(function (u) { return u.pk; }));
    var followingPks = new Set((following || []).map(function (u) { return u.pk; }));
    return {
      notFollowingBack: (following || []).filter(function (u) { return !followerPks.has(u.pk); }),
      fansYouDontFollow: (followers || []).filter(function (u) { return !followingPks.has(u.pk); })
    };
  }

  /** Why (if at all) a user must be spared. Returns null when safe to unfollow. */
  function skipReason(user, config) {
    var cfg = config || CONFIG;
    var list = (cfg.WHITELIST || []).map(function (n) { return String(n).toLowerCase(); });
    if (list.indexOf(String(user.username).toLowerCase()) !== -1) return 'whitelisted';
    if (user.follower_count == null) return 'follower count unknown';
    if (user.follower_count >= cfg.MIN_FOLLOWERS_TO_KEEP) return 'has ' + user.follower_count + ' followers';
    return null;
  }

  function csvEscape(value) {
    var s = value == null ? '' : String(value);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCSV(rows, columns) {
    var cols = columns || ['username', 'full_name', 'pk', 'is_verified', 'is_private'];
    var lines = [cols.map(csvEscape).join(',')];
    (rows || []).forEach(function (row) {
      lines.push(cols.map(function (c) { return csvEscape(row[c]); }).join(','));
    });
    return lines.join('\r\n');
  }

  /** Pull Instagram's human-readable reason out of an error response body. */
  function extractIgMessage(bodyText) {
    if (!bodyText) return '';
    try {
      var j = JSON.parse(bodyText);
      var msg = j.message || j.error_title || j.feedback_message || j.error_message;
      if (typeof msg === 'string') return msg;
      if (msg && typeof msg === 'object') return JSON.stringify(msg);
      return '';
    } catch (err) {
      return ''; // HTML challenge page or truncated JSON
    }
  }

  /**
   * A checkpoint/challenge means the account is flagged and every endpoint will
   * keep failing until a human clears it in the browser. Retrying deepens the block,
   * so this must be detected before any backoff path and must never be retried.
   */
  function detectCheckpoint(bodyText) {
    if (!bodyText) return null;
    var parsed;
    try { parsed = JSON.parse(bodyText); } catch (err) { parsed = null; }

    if (parsed && (parsed.checkpoint_url || parsed.challenge || parsed.challenge_url)) {
      return {
        url: parsed.checkpoint_url || parsed.challenge_url ||
             (parsed.challenge && (parsed.challenge.url || parsed.challenge.api_path)) || null,
        locked: parsed.lock === true
      };
    }
    var message = parsed ? (parsed.message || '') : '';
    if (/^(checkpoint|challenge)_required$/i.test(String(message))) {
      return { url: null, locked: parsed.lock === true };
    }
    return null;
  }

  /**
   * Instagram returns soft throttles as 400 with a "wait" message rather than 429,
   * so the status code alone cannot classify the failure.
   */
  function isThrottleMessage(message) {
    if (!message) return false;
    return /wait a few|try again|rate limit|too many|slow down|please wait/i.test(message);
  }

  /** Attach HTTP context so callers can branch on it without re-parsing text. */
  function annotate(err, status, bodyText) {
    err.status = status;
    err.body = bodyText;
    return err;
  }

  /** Clamp an exponential backoff, honoring a Retry-After header when sane. */
  function backoffMs(attempt, retryAfterSeconds) {
    var ra = Number(retryAfterSeconds);
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60 * 60 * 1000);
    return Math.min(60000 * Math.pow(2, attempt), 15 * 60 * 1000);
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function randomDelay(range) {
    return range[0] + Math.random() * (range[1] - range[0]);
  }

  function AuthError(msg) { var e = new Error(msg); e.name = 'AuthError'; return e; }
  function RateLimitError(msg) { var e = new Error(msg); e.name = 'RateLimitError'; return e; }
  function CheckpointError(msg) { var e = new Error(msg); e.name = 'CheckpointError'; return e; }

  function headers(extra) {
    var csrf = getCookie('csrftoken');
    if (!csrf) throw AuthError('No csrftoken cookie. Are you logged in on www.instagram.com?');
    var h = {
      'accept': '*/*',
      'x-csrftoken': csrf,
      'x-ig-app-id': IG_APP_ID,
      'x-requested-with': 'XMLHttpRequest'
    };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  async function requestJSON(path, options) {
    var opts = options || {};
    var attempt = 0;

    while (true) {
      var res;
      try {
        res = await fetch(API_ORIGIN + path, {
          method: opts.method || 'GET',
          headers: headers(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : null),
          body: opts.body || null,
          credentials: 'same-origin',
          mode: 'cors',
          referrer: API_ORIGIN + '/',
          referrerPolicy: 'strict-origin-when-cross-origin'
        });
      } catch (netErr) {
        // Transport-level failure (offline, DNS, connection reset).
        if (attempt >= CONFIG.MAX_RETRIES) {
          throw new Error('Network failure on ' + path + ': ' + netErr.message);
        }
        var netWait = Math.min(30000, 2000 * Math.pow(2, attempt));
        console.warn('[IGCheck] network error, retrying in ' + Math.round(netWait / 1000) + 's:', netErr.message);
        await sleep(netWait);
        attempt++;
        continue;
      }

      if (res.status === 200) {
        try {
          return await res.json();
        } catch (parseErr) {
          throw new Error('Instagram returned non-JSON for ' + path + ' (likely a login or challenge page).');
        }
      }

      // Instagram explains itself in the body on 4xx. Read it before deciding anything.
      var bodyText = '';
      try { bodyText = (await res.text()).slice(0, 800); } catch (readErr) { bodyText = '<body unreadable>'; }
      var igMessage = extractIgMessage(bodyText);
      var detail = igMessage
        ? ' — Instagram says: "' + igMessage + '"'
        : (bodyText ? ' — body: ' + bodyText : '');

      console.warn('[IGCheck] HTTP ' + res.status + ' on ' + path + detail);

      // Checked first and never retried: a checkpoint fails every endpoint until cleared.
      var checkpoint = detectCheckpoint(bodyText);
      if (checkpoint) {
        var err = CheckpointError(
          'Instagram has flagged this account with a security checkpoint' +
          (checkpoint.locked ? ' and LOCKED it' : '') + '.\n' +
          '  Open ' + (checkpoint.url || 'https://www.instagram.com/challenge/') + ' in this browser\n' +
          '  and complete the verification. Every request fails until you do.\n' +
          '  Do NOT re-run this script until the account is clear.'
        );
        err.checkpointUrl = checkpoint.url;
        err.locked = checkpoint.locked;
        throw annotate(err, res.status, bodyText);
      }

      if (res.status === 429 || res.status === 503 || isThrottleMessage(igMessage)) {
        if (attempt >= CONFIG.MAX_RETRIES) {
          throw annotate(RateLimitError('Throttled on ' + path + ' after ' + (attempt + 1) + ' attempts' + detail), res.status, bodyText);
        }
        var wait = backoffMs(attempt, res.headers.get('retry-after'));
        console.warn('[IGCheck] throttled (' + res.status + '). Waiting ' + Math.round(wait / 60000) + ' min...');
        await sleep(wait);
        attempt++;
        continue;
      }

      if (res.status === 401) throw annotate(AuthError('401 — session expired. Reload Instagram, log in, run again.' + detail), 401, bodyText);
      if (res.status === 403) throw annotate(AuthError('403 — CSRF rejected or the account hit a checkpoint. Open instagram.com and clear any prompts.' + detail), 403, bodyText);
      if (res.status === 404) throw annotate(new Error('404 — endpoint moved: ' + path + detail), 404, bodyText);

      throw annotate(new Error('HTTP ' + res.status + ' on ' + path + detail), res.status, bodyText);
    }
  }

  // ---------------------------------------------------------------------------
  // Instagram calls
  // ---------------------------------------------------------------------------

  /** Confirm the browser session belongs to CONFIG.TARGET_USERNAME. */
  async function verifySession() {
    var myId = getCookie('ds_user_id');
    if (!myId) throw AuthError('No ds_user_id cookie — you are not logged in on www.instagram.com.');

    var data = await requestJSON('/api/v1/users/' + encodeURIComponent(myId) + '/info/');
    var me = data && data.user;
    if (!me || !me.username) throw new Error('Could not read the logged-in profile.');

    // Read-only script: an unset TARGET_USERNAME just means "whoever is logged in".
    var expected = String(CONFIG.TARGET_USERNAME || '').toLowerCase();
    if (!expected) {
      console.warn('[IGCheck] TARGET_USERNAME is not set — operating on @' + me.username +
        '. Set CONFIG.TARGET_USERNAME to guard against running on the wrong account.');
    } else if (String(me.username).toLowerCase() !== expected) {
      throw new Error(
        'Session mismatch: logged in as @' + me.username + ', but TARGET_USERNAME is @' +
        CONFIG.TARGET_USERNAME + '. Switch accounts or edit CONFIG. Aborting.'
      );
    }
    return { id: String(myId), username: me.username, follower_count: me.follower_count, following_count: me.following_count };
  }

  function checkpointKey(userId, which) { return 'igcheck:' + userId + ':' + which; }

  /** Persist partial progress so a throttle never costs a completed page. */
  function saveCheckpoint(userId, which, users, resumeMaxId, complete) {
    try {
      localStorage.setItem(checkpointKey(userId, which), JSON.stringify({
        users: users, resumeMaxId: resumeMaxId, complete: !!complete, ts: Date.now()
      }));
    } catch (err) {
      // Quota exceeded or storage disabled: progress stays in memory only.
      console.warn('[IGCheck] could not save checkpoint: ' + err.message);
    }
  }

  function loadCheckpoint(userId, which) {
    try {
      var raw = localStorage.getItem(checkpointKey(userId, which));
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || !Array.isArray(saved.users)) return null;
      return saved;
    } catch (err) {
      return null;
    }
  }

  function clearCheckpoints(userId) {
    ['followers', 'following'].forEach(function (which) {
      try { localStorage.removeItem(checkpointKey(userId, which)); } catch (err) { /* ignore */ }
    });
  }

  /**
   * Page through /followers/ or /following/.
   * Always returns what it collected; `complete` says whether the list ran out.
   * Partial results survive a throttle because every page is checkpointed.
   */
  async function fetchList(userId, which, options) {
    var opts = options || {};
    var out = opts.into || [];
    var seen = new Set(out.map(function (u) { return u.pk; }));
    var maxId = opts.startMaxId || null;
    var page = 0;
    var complete = false;

    if (out.length) console.log('[IGCheck] ' + which + ': resuming from ' + out.length + ' already collected');

    try {
      while (page < CONFIG.MAX_PAGES) {
        var path = '/api/v1/friendships/' + encodeURIComponent(userId) + '/' + which +
          '/?count=' + CONFIG.PAGE_SIZE +
          (maxId ? '&max_id=' + encodeURIComponent(maxId) : '') +
          '&search_surface=follow_list_page';

        var data = await requestJSON(path);
        var users = (data && data.users) || [];

        users.forEach(function (raw) {
          var u = normalizeUser(raw);
          if (u && !seen.has(u.pk)) { seen.add(u.pk); out.push(u); }
        });

        page++;
        var next = data && data.next_max_id;

        if (!next || users.length === 0) { complete = true; }
        else if (String(next) === String(maxId)) {
          console.warn('[IGCheck] pagination stalled on max_id ' + next + ', stopping.');
          complete = true;
        }

        // Checkpoint the cursor that fetches the NEXT page, so a resume retries exactly there.
        if (!complete) maxId = String(next);
        saveCheckpoint(userId, which, out, maxId, complete);
        console.log('[IGCheck] ' + which + ': ' + out.length + ' collected (page ' + page + ')' + (complete ? ' — end of list' : ''));

        if (complete) break;
        await sleep(randomDelay(CONFIG.PAGE_DELAY_MS));
      }
    } catch (err) {
      saveCheckpoint(userId, which, out, maxId, false);
      err.partial = { which: which, collected: out.length, resumeMaxId: maxId };
      console.warn('[IGCheck] ' + which + ' stopped at ' + out.length +
        ' collected. Progress saved — IGCheck.resume() picks up from this cursor.');
      throw err;
    }

    if (!complete && page >= CONFIG.MAX_PAGES) {
      console.warn('[IGCheck] hit MAX_PAGES (' + CONFIG.MAX_PAGES + '); ' + which + ' list is incomplete.');
    }
    return { users: out, complete: complete, resumeMaxId: maxId };
  }

  /** Follower count for one user, or null when it cannot be read. */
  async function fetchFollowerCount(pk) {
    try {
      var data = await requestJSON('/api/v1/users/' + encodeURIComponent(pk) + '/info/');
      var c = data && data.user && data.user.follower_count;
      return typeof c === 'number' ? c : null;
    } catch (err) {
      if (err.name === 'RateLimitError' || err.name === 'AuthError' || err.name === 'CheckpointError') throw err;
      console.warn('[IGCheck] could not read follower count for ' + pk + ': ' + err.message);
      return null;
    }
  }

  async function unfollowOne(user) {
    var body = 'user_id=' + encodeURIComponent(user.pk) + '&container_module=following_sheet';
    var data = await requestJSON('/api/v1/friendships/destroy/' + encodeURIComponent(user.pk) + '/', {
      method: 'POST',
      body: body
    });
    if (!data || data.status !== 'ok') {
      throw new Error('Unfollow of @' + user.username + ' returned: ' + JSON.stringify(data));
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var state = { me: null, followers: [], following: [], notFollowingBack: [], fansYouDontFollow: [], complete: false };

  async function run(options) {
    var opts = options || {};
    try {
      console.log('[IGCheck] verifying session...');
      state.me = await verifySession();
      console.log('[IGCheck] logged in as @' + state.me.username + ' (id ' + state.me.id + ')');

      if (!opts.resume) clearCheckpoints(state.me.id);

      var lists = {};
      for (var i = 0; i < 2; i++) {
        var which = i === 0 ? 'followers' : 'following';
        var saved = opts.resume ? loadCheckpoint(state.me.id, which) : null;

        // Bind the bucket to state BEFORE fetching: fetchList mutates it in place,
        // so a throw mid-list leaves the collected users reachable instead of discarded.
        var bucket = saved ? saved.users : [];
        state[which] = bucket;

        if (saved && saved.complete) {
          console.log('[IGCheck] ' + which + ': already complete (' + bucket.length + '), skipping');
          lists[which] = { users: bucket, complete: true };
        } else {
          lists[which] = await fetchList(state.me.id, which, {
            into: bucket,
            startMaxId: saved ? saved.resumeMaxId : null
          });
        }
        if (i === 0) await sleep(randomDelay(CONFIG.PAGE_DELAY_MS));
      }

      state.complete = lists.followers.complete && lists.following.complete;
      if (!state.complete) {
        console.warn('[IGCheck] one or both lists are incomplete — the diff below may include false positives.');
      }

      var diff = diffFollows(state.following, state.followers);
      state.notFollowingBack = diff.notFollowingBack;
      state.fansYouDontFollow = diff.fansYouDontFollow;

      console.log(
        '\n[IGCheck] @' + state.me.username + '\n' +
        '  followers fetched: ' + state.followers.length + '\n' +
        '  following fetched: ' + state.following.length + '\n' +
        '  NOT following you back: ' + state.notFollowingBack.length + '\n' +
        '  follow you, you do not follow back: ' + state.fansYouDontFollow.length
      );

      if (state.notFollowingBack.length) {
        console.table(state.notFollowingBack.map(function (u) {
          return { username: u.username, name: u.full_name, verified: u.is_verified, private: u.is_private };
        }));
      }

      console.log(
        '[IGCheck] results on window.IGCheck.results — ' +
        'IGCheck.downloadCSV() saves them. ' +
        (CONFIG.DRY_RUN
          ? 'DRY_RUN is on; nothing will be unfollowed.'
          : 'DRY_RUN is off; IGCheck.unfollowAll() is armed.')
      );

      return state;
    } catch (err) {
      console.error('[IGCheck] ' + err.name + ': ' + err.message);
      if (err.partial) {
        console.error('[IGCheck] kept ' + err.partial.collected + ' ' + err.partial.which + ' (checkpointed).');
        if (err.name === 'CheckpointError') {
          console.error('[IGCheck] Clear the challenge in the browser FIRST. Do not resume until the account is unlocked.');
        } else {
          console.error('[IGCheck] Wait for the block to clear, then run: await IGCheck.resume()');
        }
      }
      throw err;
    }
  }

  /** Continue from the last checkpoint instead of restarting from page 1. */
  function resume() { return run({ resume: true }); }

  async function unfollowAll() {
    if (CONFIG.DRY_RUN) {
      console.warn('[IGCheck] DRY_RUN is true — refusing to unfollow. Set IGCheck.CONFIG.DRY_RUN = false first.');
      return { unfollowed: [], skipped: [], failed: [] };
    }
    if (!state.notFollowingBack.length) {
      console.warn('[IGCheck] nothing to do — run IGCheck.run() first.');
      return { unfollowed: [], skipped: [], failed: [] };
    }

    var result = { unfollowed: [], skipped: [], failed: [] };
    var targets = state.notFollowingBack.slice(0, CONFIG.MAX_UNFOLLOWS_PER_RUN);
    console.log('[IGCheck] unfollowing up to ' + targets.length + ' accounts. This is slow on purpose.');

    for (var i = 0; i < targets.length; i++) {
      var user = targets[i];
      try {
        var quickSkip = skipReason({ username: user.username, follower_count: 0 }, CONFIG);
        if (quickSkip === 'whitelisted') {
          result.skipped.push({ username: user.username, reason: quickSkip });
          continue;
        }

        user.follower_count = await fetchFollowerCount(user.pk);
        var reason = skipReason(user, CONFIG);
        if (reason) {
          console.log('[IGCheck] skip @' + user.username + ' (' + reason + ')');
          result.skipped.push({ username: user.username, reason: reason });
          continue;
        }

        await unfollowOne(user);
        result.unfollowed.push(user.username);
        console.log('[IGCheck] unfollowed @' + user.username + ' (' + result.unfollowed.length + '/' + targets.length + ')');

        if (result.unfollowed.length % CONFIG.UNFOLLOW_BATCH_SIZE === 0) {
          console.log('[IGCheck] batch pause: ' + Math.round(CONFIG.UNFOLLOW_BATCH_PAUSE_MS / 60000) + ' min');
          await sleep(CONFIG.UNFOLLOW_BATCH_PAUSE_MS);
        } else {
          await sleep(randomDelay(CONFIG.UNFOLLOW_DELAY_MS));
        }
      } catch (err) {
        if (err.name === 'AuthError' || err.name === 'RateLimitError' || err.name === 'CheckpointError') {
          console.error('[IGCheck] stopping: ' + err.message);
          result.failed.push({ username: user.username, error: err.message });
          break;
        }
        console.warn('[IGCheck] failed on @' + user.username + ': ' + err.message);
        result.failed.push({ username: user.username, error: err.message });
      }
    }

    console.log('[IGCheck] done. unfollowed=' + result.unfollowed.length +
      ' skipped=' + result.skipped.length + ' failed=' + result.failed.length);
    return result;
  }

  function downloadCSV(which) {
    var key = which || 'notFollowingBack';
    var rows = state[key];
    if (!rows || !rows.length) { console.warn('[IGCheck] nothing to export for "' + key + '".'); return; }
    var blob = new Blob(['﻿' + toCSV(rows)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ig-' + key + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var IGCheck = {
    CONFIG: CONFIG,
    run: run,
    resume: resume,
    unfollowAll: unfollowAll,
    downloadCSV: downloadCSV,
    reset: function () { if (state.me) clearCheckpoints(state.me.id); },
    get results() { return state; },
    // exposed for tests
    _pure: {
      getCookie: getCookie, normalizeUser: normalizeUser, diffFollows: diffFollows,
      skipReason: skipReason, toCSV: toCSV, csvEscape: csvEscape, backoffMs: backoffMs,
      extractIgMessage: extractIgMessage, isThrottleMessage: isThrottleMessage,
      detectCheckpoint: detectCheckpoint, annotate: annotate
    }
  };

  root.IGCheck = IGCheck;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = IGCheck;
  } else if (typeof window !== 'undefined' && typeof fetch === 'function') {
    IGCheck.run().catch(function () { /* already logged */ });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

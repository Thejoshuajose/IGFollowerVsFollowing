/*!
 * ig-unfollow.js — acts on the list ig-observe.js produced.
 *
 * Copyright (c) 2026 FIWB Solutions LLC. MIT licensed — see LICENSE.
 * Author: Joshua Gonzales
 *
 * THIS SCRIPT SENDS WRITES. ig-observe.js is passive; this one is not, and writes
 * are what draw action blocks. It is the part that put the account at risk before.
 * DRY_RUN is on by default and unfollowAll() refuses to run until you turn it off.
 *
 * Usage:
 *   1. Run ig-observe.js first and click "Diff" — this reads its saved list.
 *   2. Paste this file. It prints a plan and does nothing else.
 *   3. Review the plan. Whitelist anyone you want to keep.
 *   4. IGUnfollow.CONFIG.DRY_RUN = false; await IGUnfollow.unfollowAll();
 */
;(function (root) {
  'use strict';

  var CONFIG = {
    // REQUIRED. This script writes, so it refuses to run until you name the account
    // explicitly — it will not act on "whoever happens to be logged in".
    TARGET_USERNAME: '',

    DRY_RUN: true,

    // Usernames never unfollowed, whatever else is true. Lowercase.
    WHITELIST: [],

    // Verified accounts are skipped using the flag the observer already captured,
    // which costs no extra requests. The follower-count lookup below is the
    // alternative, and it doubles the request count.
    SKIP_VERIFIED: true,

    // Off by default: turning this on issues one extra GET per candidate.
    CHECK_FOLLOWER_COUNT: false,
    MIN_FOLLOWERS_TO_KEEP: 10000,

    // Deliberately slow. The account has been flagged once already.
    MAX_UNFOLLOWS_PER_RUN: 15,
    DELAY_MS: [45000, 120000],
    BATCH_SIZE: 5,
    BATCH_PAUSE_MS: 20 * 60 * 1000
  };

  var API_ORIGIN = 'https://www.instagram.com';
  var LIST_KEY = 'igobserve:notFollowingBack';
  var OBSERVE_KEY = 'igobserve:v1';
  var PROGRESS_KEY = 'igunfollow:done';

  // ---------------------------------------------------------------------------
  // Pure helpers (unit-tested in ig-unfollow.test.cjs)
  // ---------------------------------------------------------------------------

  function getCookie(name, cookieString) {
    var raw = typeof cookieString === 'string'
      ? cookieString : (typeof document !== 'undefined' ? document.cookie : '');
    var parts = ('; ' + raw).split('; ' + name + '=');
    if (parts.length < 2) return null;
    var v = parts.pop().split(';').shift();
    if (!v) return null;
    try { return decodeURIComponent(v); } catch (e) { return v; }
  }

  /** Why a candidate must be spared, or null when it is safe to unfollow. */
  function skipReason(user, config) {
    var cfg = config || CONFIG;
    var list = (cfg.WHITELIST || []).map(function (n) { return String(n).toLowerCase(); });
    if (list.indexOf(String(user.username || '').toLowerCase()) !== -1) return 'whitelisted';
    if (cfg.SKIP_VERIFIED && user.is_verified) return 'verified';
    if (cfg.CHECK_FOLLOWER_COUNT) {
      if (user.follower_count == null) return 'follower count unknown';
      if (user.follower_count >= cfg.MIN_FOLLOWERS_TO_KEEP) return 'has ' + user.follower_count + ' followers';
    }
    return null;
  }

  /** Split candidates into what would actually be unfollowed and what is spared. */
  function buildPlan(candidates, alreadyDone, config) {
    var done = new Set(alreadyDone || []);
    var plan = { willUnfollow: [], skipped: [], alreadyDone: [] };
    (candidates || []).forEach(function (u) {
      if (done.has(u.pk)) { plan.alreadyDone.push(u); return; }
      var reason = skipReason(u, config);
      if (reason) plan.skipped.push({ user: u, reason: reason });
      else plan.willUnfollow.push(u);
    });
    return plan;
  }

  function detectCheckpoint(bodyText) {
    if (!bodyText) return null;
    var parsed;
    try { parsed = JSON.parse(bodyText); } catch (err) { return null; }
    if (parsed.checkpoint_url || parsed.challenge_url) {
      return { url: parsed.checkpoint_url || parsed.challenge_url, locked: parsed.lock === true };
    }
    if (/^(checkpoint|challenge)_required$/i.test(String(parsed.message || ''))) {
      return { url: null, locked: parsed.lock === true };
    }
    return null;
  }

  function isThrottleMessage(message) {
    if (!message) return false;
    return /wait a few|try again|rate limit|too many|slow down|please wait/i.test(String(message));
  }

  /** Merge captured client headers with the ones we must always set. */
  function buildHeaders(capturedHeaders, csrfToken) {
    var out = {};
    var captured = capturedHeaders || {};
    Object.keys(captured).forEach(function (k) {
      if (captured[k]) out[k.toLowerCase()] = String(captured[k]);
    });
    out['x-csrftoken'] = csrfToken;                    // must be current, never replayed
    if (!out['x-ig-app-id']) out['x-ig-app-id'] = '936619743392459';
    out['content-type'] = 'application/x-www-form-urlencoded';
    return out;
  }

  // ---------------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------------

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function randomDelay(range) { return range[0] + Math.random() * (range[1] - range[0]); }

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) { return fallback; }
  }

  function loadCandidates() {
    var list = loadJSON(LIST_KEY, null);
    if (!Array.isArray(list)) return null;
    return list;
  }

  function loadCapturedHeaders() {
    var saved = loadJSON(OBSERVE_KEY, null);
    return (saved && saved.headers) || null;
  }

  function loadDone() { return loadJSON(PROGRESS_KEY, []) || []; }

  function saveDone(pks) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(pks)); }
    catch (err) { console.warn('[IGUnfollow] could not save progress: ' + err.message); }
  }

  function CheckpointError(msg) { var e = new Error(msg); e.name = 'CheckpointError'; return e; }
  function AuthError(msg) { var e = new Error(msg); e.name = 'AuthError'; return e; }
  function RateLimitError(msg) { var e = new Error(msg); e.name = 'RateLimitError'; return e; }

  async function request(path, method, body) {
    var csrf = getCookie('csrftoken');
    if (!csrf) throw AuthError('No csrftoken cookie — log in on www.instagram.com first.');

    var res = await fetch(API_ORIGIN + path, {
      method: method,
      headers: buildHeaders(loadCapturedHeaders(), csrf),
      body: body || null,
      credentials: 'same-origin',
      referrer: API_ORIGIN + '/',
      referrerPolicy: 'strict-origin-when-cross-origin'
    });

    var text = '';
    try { text = (await res.text()).slice(0, 800); } catch (e) { text = ''; }

    if (res.status === 200) {
      try { return JSON.parse(text); }
      catch (e) { throw new Error('Non-JSON response on ' + path + ' (challenge page?).'); }
    }

    var checkpoint = detectCheckpoint(text);
    if (checkpoint) {
      throw CheckpointError('Account checkpointed' + (checkpoint.locked ? ' and LOCKED' : '') +
        '. Open ' + (checkpoint.url || API_ORIGIN + '/challenge/') + ' and clear it. Stopping.');
    }

    var message = '';
    try { message = JSON.parse(text).message || ''; } catch (e) { message = ''; }
    if (res.status === 429 || isThrottleMessage(message)) {
      throw RateLimitError('Throttled on ' + path + ' — "' + message + '". Stopping.');
    }
    if (res.status === 401 || res.status === 403) {
      throw AuthError('HTTP ' + res.status + ' on ' + path + ' — "' + message + '".');
    }
    throw new Error('HTTP ' + res.status + ' on ' + path + ' — ' + text);
  }

  async function fetchFollowerCount(pk) {
    var data = await request('/api/v1/users/' + encodeURIComponent(pk) + '/info/', 'GET');
    var c = data && data.user && data.user.follower_count;
    return typeof c === 'number' ? c : null;
  }

  async function verifySession() {
    if (!String(CONFIG.TARGET_USERNAME || '').trim()) {
      throw new Error('CONFIG.TARGET_USERNAME is not set. This script writes — set it to your ' +
        'handle first so it cannot act on the wrong account.');
    }
    var myId = getCookie('ds_user_id');
    if (!myId) throw AuthError('Not logged in on www.instagram.com.');
    var data = await request('/api/v1/users/' + encodeURIComponent(myId) + '/info/', 'GET');
    var me = data && data.user;
    if (!me || !me.username) throw new Error('Could not read the logged-in profile.');
    if (String(me.username).toLowerCase() !== String(CONFIG.TARGET_USERNAME).toLowerCase()) {
      throw new Error('Session mismatch: logged in as @' + me.username +
        ', expected @' + CONFIG.TARGET_USERNAME + '. Aborting.');
    }
    return me;
  }

  function plan() {
    var candidates = loadCandidates();
    if (!candidates) {
      console.error('[IGUnfollow] no list found. Run ig-observe.js and click "Diff" first.');
      return null;
    }
    var p = buildPlan(candidates, loadDone(), CONFIG);
    console.log('[IGUnfollow] candidates: ' + candidates.length +
      ' | would unfollow: ' + p.willUnfollow.length +
      ' | spared: ' + p.skipped.length +
      ' | already done: ' + p.alreadyDone.length);
    if (p.willUnfollow.length) {
      console.table(p.willUnfollow.slice(0, 50).map(function (u) {
        return { username: u.username, name: u.full_name, verified: u.is_verified };
      }));
    }
    if (p.skipped.length) {
      console.table(p.skipped.slice(0, 50).map(function (s) {
        return { username: s.user.username, spared: s.reason };
      }));
    }
    var runs = Math.ceil(p.willUnfollow.length / CONFIG.MAX_UNFOLLOWS_PER_RUN);
    if (runs > 1) {
      console.log('[IGUnfollow] at ' + CONFIG.MAX_UNFOLLOWS_PER_RUN + ' per run this needs ' +
        runs + ' sittings. Spread them over days, not hours.');
    }
    return p;
  }

  async function unfollowAll() {
    if (CONFIG.DRY_RUN) {
      console.warn('[IGUnfollow] DRY_RUN is true — nothing sent. Review IGUnfollow.plan(), then set ' +
        'IGUnfollow.CONFIG.DRY_RUN = false to arm this.');
      return { unfollowed: [], failed: [], stopped: 'dry-run' };
    }

    await verifySession();

    var p = plan();
    if (!p || !p.willUnfollow.length) return { unfollowed: [], failed: [], stopped: 'nothing-to-do' };

    var targets = p.willUnfollow.slice(0, CONFIG.MAX_UNFOLLOWS_PER_RUN);
    var done = loadDone();
    var result = { unfollowed: [], failed: [], stopped: null };

    console.log('[IGUnfollow] starting on ' + targets.length + ' accounts. Keep this tab focused.');

    for (var i = 0; i < targets.length; i++) {
      var user = targets[i];
      try {
        if (CONFIG.CHECK_FOLLOWER_COUNT) {
          user.follower_count = await fetchFollowerCount(user.pk);
          var late = skipReason(user, CONFIG);
          if (late) { console.log('[IGUnfollow] skip @' + user.username + ' (' + late + ')'); continue; }
          await sleep(randomDelay([3000, 8000]));
        }

        var data = await request(
          '/api/v1/friendships/destroy/' + encodeURIComponent(user.pk) + '/',
          'POST',
          'user_id=' + encodeURIComponent(user.pk) + '&container_module=following_sheet'
        );
        if (!data || data.status !== 'ok') throw new Error('unexpected response: ' + JSON.stringify(data));

        result.unfollowed.push(user.username);
        done.push(user.pk);
        saveDone(done);
        console.log('[IGUnfollow] unfollowed @' + user.username +
          ' (' + result.unfollowed.length + '/' + targets.length + ')');

        if (i === targets.length - 1) break;
        if (result.unfollowed.length % CONFIG.BATCH_SIZE === 0) {
          console.log('[IGUnfollow] batch pause ' + Math.round(CONFIG.BATCH_PAUSE_MS / 60000) + ' min');
          await sleep(CONFIG.BATCH_PAUSE_MS);
        } else {
          await sleep(randomDelay(CONFIG.DELAY_MS));
        }
      } catch (err) {
        result.failed.push({ username: user.username, error: err.message });
        if (err.name === 'CheckpointError' || err.name === 'RateLimitError' || err.name === 'AuthError') {
          result.stopped = err.name;
          console.error('[IGUnfollow] HARD STOP — ' + err.message);
          console.error('[IGUnfollow] ' + result.unfollowed.length + ' done this run, saved. Do not re-run today.');
          break;
        }
        console.warn('[IGUnfollow] failed on @' + user.username + ': ' + err.message);
      }
    }

    console.log('[IGUnfollow] finished. unfollowed=' + result.unfollowed.length +
      ' failed=' + result.failed.length + (result.stopped ? ' stopped=' + result.stopped : ''));
    return result;
  }

  var api = {
    CONFIG: CONFIG,
    plan: plan,
    unfollowAll: unfollowAll,
    resetProgress: function () {
      try { localStorage.removeItem(PROGRESS_KEY); } catch (e) { /* ignore */ }
      console.log('[IGUnfollow] progress cleared.');
    },
    _pure: {
      getCookie: getCookie, skipReason: skipReason, buildPlan: buildPlan,
      detectCheckpoint: detectCheckpoint, isThrottleMessage: isThrottleMessage,
      buildHeaders: buildHeaders
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    root.IGUnfollow = api;
    console.log('[IGUnfollow] loaded. DRY_RUN is ON — nothing will be sent.');
    plan();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

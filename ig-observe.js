/*!
 * ig-observe.js — passive follower/following collector.
 *
 * Copyright (c) 2026 FIWB Solutions LLC. MIT licensed — see LICENSE.
 * Author: Joshua Gonzales
 *
 * Issues ZERO requests to Instagram. It wraps the page's own fetch/XHR and reads
 * the friendship-list responses Instagram's client already makes while you scroll
 * your Followers / Following lists by hand. The traffic is the real client's,
 * because it is the real client's.
 *
 * Usage:
 *   1. Open your own Instagram profile page, logged in.
 *   2. Paste this file into the DevTools console. A small panel appears.
 *   3. Click "Followers", scroll to the bottom of the list at a human pace.
 *   4. Close it, click "Following", scroll to the bottom.
 *   5. Click "Diff" in the panel.
 *
 * Progress is saved to localStorage as you go, so it survives a reload and can be
 * finished across several sittings.
 */
;(function (root) {
  'use strict';

  var CONFIG = {
    // Operates on whichever account is logged in — it reads that session's ds_user_id.
    ONLY_MY_LISTS: true,   // ignore other people's follower lists you happen to browse
    SAVE_DEBOUNCE_MS: 1000
  };

  var STORAGE_KEY = 'igobserve:v1';
  var LIST_URL_RE = /\/api\/v1\/friendships\/(\d+)\/(followers|following)\//;
  var INTERESTING_HEADERS = [
    'x-ig-app-id', 'x-ig-www-claim', 'x-asbd-id', 'x-csrftoken',
    'x-web-session-id', 'x-requested-with', 'x-ig-d'
  ];

  // ---------------------------------------------------------------------------
  // Pure helpers (unit-tested in ig-observe.test.cjs)
  // ---------------------------------------------------------------------------

  /** Identify a friendships list response by URL. Returns null for anything else. */
  function parseListUrl(url) {
    if (!url) return null;
    var m = LIST_URL_RE.exec(String(url));
    if (!m) return null;
    return { userId: m[1], which: m[2] };
  }

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

  /** Pull the user array out of a friendships payload, tolerating shape drift. */
  function extractUsers(payload) {
    if (!payload) return [];
    var raw = payload.users || payload.big_list_users || [];
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var u = normalizeUser(raw[i]);
      if (u) out.push(u);
    }
    return out;
  }

  /** Merge users into a pk-keyed store. Returns how many were new. */
  function mergeUsers(store, users) {
    var added = 0;
    (users || []).forEach(function (u) {
      if (!store[u.pk]) { store[u.pk] = u; added++; }
      else { store[u.pk] = u; } // refresh, e.g. after a username change
    });
    return added;
  }

  function diffFollows(following, followers) {
    var followerPks = new Set((followers || []).map(function (u) { return u.pk; }));
    var followingPks = new Set((following || []).map(function (u) { return u.pk; }));
    return {
      notFollowingBack: (following || []).filter(function (u) { return !followerPks.has(u.pk); }),
      fansYouDontFollow: (followers || []).filter(function (u) { return !followingPks.has(u.pk); })
    };
  }

  /**
   * Strip only a trailing word label ("1,450 followers" -> "1,450").
   * Must not touch a magnitude suffix: "1.4K" has to survive intact.
   */
  function stripCountLabel(text) {
    if (text == null) return '';
    return String(text).replace(/\s+(followers?|following)\s*$/i, '').trim();
  }

  /** Parse a count the profile header shows: "1,450", "1.4K", "2M". */
  function parseCount(text) {
    if (text == null) return null;
    var s = String(text).trim().replace(/,/g, '');
    var m = /^([\d.]+)\s*([KkMmBb])?/.exec(s);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    var suffix = (m[2] || '').toLowerCase();
    if (suffix === 'k') n *= 1e3;
    else if (suffix === 'm') n *= 1e6;
    else if (suffix === 'b') n *= 1e9;
    return Math.round(n);
  }

  /** Keep only the client headers worth replaying; drop everything else. */
  function pickClientHeaders(headersLike) {
    var out = {};
    if (!headersLike) return out;

    var read = function (name) {
      if (typeof headersLike.get === 'function') return headersLike.get(name);
      var keys = Object.keys(headersLike);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === name) return headersLike[keys[i]];
      }
      return null;
    };

    INTERESTING_HEADERS.forEach(function (name) {
      var v = read(name);
      if (v != null && v !== '') out[name] = String(v);
    });
    return out;
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

  /** A checkpoint seen passively still means the account is flagged. */
  function isCheckpointPayload(payload) {
    if (!payload) return false;
    if (payload.checkpoint_url || payload.challenge_url) return true;
    return /^(checkpoint|challenge)_required$/i.test(String(payload.message || ''));
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = { myId: null, followers: {}, following: {}, headers: null, checkpointSeen: false };
  var saveTimer = null;

  function getCookie(name) {
    var parts = ('; ' + (typeof document !== 'undefined' ? document.cookie : '')).split('; ' + name + '=');
    if (parts.length < 2) return null;
    var v = parts.pop().split(';').shift();
    if (!v) return null;
    try { return decodeURIComponent(v); } catch (e) { return v; }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        myId: state.myId, followers: state.followers, following: state.following,
        headers: state.headers, ts: Date.now()
      }));
    } catch (err) {
      console.warn('[IGObserve] could not save progress: ' + err.message);
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; save(); }, CONFIG.SAVE_DEBOUNCE_MS);
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved) return;
      state.myId = saved.myId || null;
      state.followers = saved.followers || {};
      state.following = saved.following || {};
      state.headers = saved.headers || null;
    } catch (err) {
      console.warn('[IGObserve] could not restore progress: ' + err.message);
    }
  }

  function count(which) { return Object.keys(state[which]).length; }
  function listOf(which) {
    return Object.keys(state[which]).map(function (pk) { return state[which][pk]; });
  }

  // ---------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------

  function ingest(url, payload, headersLike) {
    var info = parseListUrl(url);
    if (!info) return;

    if (isCheckpointPayload(payload)) {
      state.checkpointSeen = true;
      setMessage('Instagram returned a checkpoint. Stop and clear it in the browser.', true);
      return;
    }

    if (CONFIG.ONLY_MY_LISTS) {
      if (!state.myId) state.myId = getCookie('ds_user_id');
      if (state.myId && info.userId !== String(state.myId)) return; // someone else's list
    }

    var users = extractUsers(payload);
    if (!users.length) return;

    var added = mergeUsers(state[info.which], users);

    // Record the real client's headers once, for the unfollow script to replay.
    if (!state.headers) {
      var picked = pickClientHeaders(headersLike);
      if (Object.keys(picked).length) state.headers = picked;
    }

    scheduleSave();
    render();
    if (added) console.log('[IGObserve] ' + info.which + ': +' + added + ' (' + count(info.which) + ' total)');
  }

  // ---------------------------------------------------------------------------
  // Hooks — wrap, never replace behaviour
  // ---------------------------------------------------------------------------

  var originals = { fetch: null, open: null, send: null, setRequestHeader: null };

  function installHooks() {
    originals.fetch = root.fetch;
    root.fetch = function (input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) { url = ''; }

      var promise = originals.fetch.apply(this, arguments);

      if (parseListUrl(url)) {
        var hdrs = (init && init.headers) || (input && input.headers) || null;
        promise.then(function (res) {
          if (!res) return;
          // clone() is mandatory: reading the original body would starve Instagram's own code.
          res.clone().json().then(function (data) {
            try { ingest(url, data, hdrs); } catch (e) { console.warn('[IGObserve] ingest failed: ' + e.message); }
          }).catch(function () { /* not JSON */ });
        }).catch(function () { /* the app handles its own failures */ });
      }
      return promise;
    };

    var XHR = root.XMLHttpRequest;
    if (!XHR) return;
    originals.open = XHR.prototype.open;
    originals.send = XHR.prototype.send;
    originals.setRequestHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__igObserveUrl = url;
      this.__igObserveHeaders = {};
      return originals.open.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try { if (this.__igObserveHeaders) this.__igObserveHeaders[name] = value; } catch (e) { /* ignore */ }
      return originals.setRequestHeader.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      var xhr = this;
      if (parseListUrl(xhr.__igObserveUrl)) {
        xhr.addEventListener('load', function () {
          try {
            // responseText is non-destructive; the app can still read it.
            var data = JSON.parse(xhr.responseText);
            ingest(xhr.__igObserveUrl, data, xhr.__igObserveHeaders);
          } catch (e) { /* not JSON, or already consumed */ }
        });
      }
      return originals.send.apply(this, arguments);
    };
  }

  function removeHooks() {
    if (originals.fetch) root.fetch = originals.fetch;
    var XHR = root.XMLHttpRequest;
    if (XHR && originals.open) {
      XHR.prototype.open = originals.open;
      XHR.prototype.send = originals.send;
      XHR.prototype.setRequestHeader = originals.setRequestHeader;
    }
    root.__IG_OBSERVE_INSTALLED__ = false;
    console.log('[IGObserve] hooks removed.');
  }

  // ---------------------------------------------------------------------------
  // Target counts, read from the page (no requests)
  // ---------------------------------------------------------------------------

  function readTargetCount(which) {
    try {
      var anchor = document.querySelector('a[href$="/' + which + '/"]');
      if (!anchor) return null;
      var titled = anchor.querySelector('span[title]');
      if (titled) {
        var exact = parseCount(titled.getAttribute('title'));
        if (exact != null) return exact;
      }
      return parseCount(stripCountLabel(anchor.textContent || ''));
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------

  var hud = null;

  function buildHud() {
    if (typeof document === 'undefined') return;
    var host = document.createElement('div');
    host.id = 'ig-observe-hud';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      '.p{font:12px/1.45 -apple-system,Segoe UI,sans-serif;background:#111;color:#eee;border:1px solid #333;' +
      'border-radius:10px;padding:10px 12px;min-width:210px;box-shadow:0 6px 24px rgba(0,0,0,.45)}' +
      '.t{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px}' +
      '.r{display:flex;justify-content:space-between;margin:3px 0}' +
      '.n{font-variant-numeric:tabular-nums;font-weight:600}' +
      '.m{margin-top:8px;color:#9aa;font-size:11px}' +
      '.m.warn{color:#ff8080}' +
      'button{font:11px inherit;background:#222;color:#eee;border:1px solid #444;border-radius:6px;' +
      'padding:4px 8px;margin:6px 4px 0 0;cursor:pointer}' +
      'button:hover{background:#2c2c2c}' +
      '.x{cursor:pointer;color:#888;padding:0 4px}' +
      '</style>' +
      '<div class="p">' +
      '<div class="t"><span>IG Observe</span><span class="x" id="x">&#10005;</span></div>' +
      '<div class="r"><span>followers</span><span class="n" id="cf">0</span></div>' +
      '<div class="r"><span>following</span><span class="n" id="cg">0</span></div>' +
      '<div><button id="d">Diff</button><button id="c">CSV</button><button id="r">Reset</button></div>' +
      '<div class="m" id="m">Open Followers and scroll.</div>' +
      '</div>';

    shadow.getElementById('x').onclick = function () { host.style.display = 'none'; };
    shadow.getElementById('d').onclick = function () { api.diff(); };
    shadow.getElementById('c').onclick = function () { api.downloadCSV(); };
    shadow.getElementById('r').onclick = function () { api.reset(); };

    document.body.appendChild(host);
    hud = { host: host, shadow: shadow };
  }

  function setMessage(text, isWarning) {
    if (!hud) return;
    var el = hud.shadow.getElementById('m');
    if (!el) return;
    el.textContent = text;
    el.className = 'm' + (isWarning ? ' warn' : '');
  }

  function render() {
    if (!hud) return;
    ['followers', 'following'].forEach(function (which) {
      var el = hud.shadow.getElementById(which === 'followers' ? 'cf' : 'cg');
      if (!el) return;
      var target = readTargetCount(which);
      el.textContent = target ? (count(which) + ' / ' + target) : String(count(which));
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var api = {
    CONFIG: CONFIG,

    status: function () {
      return {
        followers: count('followers'),
        following: count('following'),
        followersTarget: readTargetCount('followers'),
        followingTarget: readTargetCount('following'),
        headersCaptured: state.headers ? Object.keys(state.headers) : [],
        checkpointSeen: state.checkpointSeen
      };
    },

    diff: function () {
      var result = diffFollows(listOf('following'), listOf('followers'));
      var f = count('followers'), g = count('following');
      var ft = readTargetCount('followers'), gt = readTargetCount('following');

      if ((ft && f < ft * 0.98) || (gt && g < gt * 0.98)) {
        console.warn('[IGObserve] lists look incomplete (followers ' + f + '/' + (ft || '?') +
          ', following ' + g + '/' + (gt || '?') + '). Scroll both lists to the very bottom, ' +
          'or the diff will report people who do follow you.');
        setMessage('Incomplete — scroll both lists fully.', true);
      } else {
        setMessage('Diff ready: ' + result.notFollowingBack.length + ' not following back.');
      }

      state.notFollowingBack = result.notFollowingBack;
      state.fansYouDontFollow = result.fansYouDontFollow;
      try {
        localStorage.setItem('igobserve:notFollowingBack', JSON.stringify(result.notFollowingBack));
      } catch (err) { console.warn('[IGObserve] could not save the diff: ' + err.message); }

      console.log('[IGObserve] not following you back: ' + result.notFollowingBack.length +
        ' | follow you, you do not follow back: ' + result.fansYouDontFollow.length);
      if (result.notFollowingBack.length) {
        console.table(result.notFollowingBack.map(function (u) {
          return { username: u.username, name: u.full_name, verified: u.is_verified };
        }));
      }
      return result;
    },

    downloadCSV: function (which) {
      var key = which || 'notFollowingBack';
      var rows = state[key] || (key === 'followers' || key === 'following' ? listOf(key) : null);
      if (!rows || !rows.length) { console.warn('[IGObserve] nothing to export for "' + key + '". Run diff first.'); return; }
      var blob = new Blob(['﻿' + toCSV(rows)], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'ig-' + key + '-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },

    reset: function () {
      state.followers = {}; state.following = {};
      delete state.notFollowingBack; delete state.fansYouDontFollow;
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem('igobserve:notFollowingBack');
      } catch (err) { /* ignore */ }
      render();
      setMessage('Cleared. Open Followers and scroll.');
      console.log('[IGObserve] cleared.');
    },

    show: function () { if (hud) hud.host.style.display = ''; },
    stop: removeHooks,
    get data() { return { followers: listOf('followers'), following: listOf('following'), headers: state.headers }; },

    _pure: {
      parseListUrl: parseListUrl, normalizeUser: normalizeUser, extractUsers: extractUsers,
      mergeUsers: mergeUsers, diffFollows: diffFollows, parseCount: parseCount,
      stripCountLabel: stripCountLabel,
      pickClientHeaders: pickClientHeaders, toCSV: toCSV, csvEscape: csvEscape,
      isCheckpointPayload: isCheckpointPayload
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    if (root.__IG_OBSERVE_INSTALLED__) {
      console.warn('[IGObserve] already running — showing the existing panel.');
      if (root.IGObserve) root.IGObserve.show();
    } else {
      root.__IG_OBSERVE_INSTALLED__ = true;
      state.myId = getCookie('ds_user_id');
      load();
      installHooks();
      buildHud();
      render();
      root.IGObserve = api;
      console.log('[IGObserve] passive collector active — it sends nothing on its own.\n' +
        'Open your Followers list and scroll to the bottom, then Following, then click Diff.');
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

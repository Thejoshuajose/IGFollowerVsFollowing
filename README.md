# ig-follow-check

Finds which Instagram accounts you follow that don't follow you back, and optionally unfollows them.

**FIWB Solutions LLC** — Joshua Gonzales

---

## Read this first

The account this was built for was **checkpointed and locked** on the first real run of `ig-follow-check.js`, from reading alone. Instagram's response:

```json
{"message":"checkpoint_required","checkpoint_url":"...","lock":true,"status":"fail"}
```

That was not a rate limit. Slowing down would not have prevented it. The traffic was flagged because it *looked like a scraper* — one endpoint called 29 times in sequence, no image loads, no telemetry, no idle gaps, and missing the `x-ig-www-claim` / `x-asbd-id` headers the real client sends.

The scripts here are ordered by how much risk they carry.

| Script | Sends requests? | Risk |
|---|---|---|
| `ig-observe.js` | **No** — reads the page's own traffic | Low |
| `ig-unfollow.js` | Yes, writes | High — this is the dangerous one |
| `ig-follow-check.js` | Yes, many reads | **Deprecated — this is what got the account locked** |

Nothing here is risk-free. Instagram detects on access *pattern*, and an already-flagged account is watched more closely.

---

## 1. `ig-observe.js` — passive collector (start here)

Issues zero requests. It wraps the page's own `fetch`/`XHR` and reads the friendship-list responses Instagram's client already makes while **you** scroll. The traffic is the real client's because it *is* the real client's — correct headers, correct cadence, correct surrounding requests.

1. Open your own Instagram profile page, logged in.
2. Paste `ig-observe.js` into the console. A small panel appears bottom-right.
3. Click **Followers**, scroll to the bottom at a human pace.
4. Close it, click **Following**, scroll to the bottom.
5. Click **Diff** in the panel.

```js
IGObserve.status()        // counts captured vs. the profile's stated totals
IGObserve.diff()          // computes and saves the not-following-back list
IGObserve.downloadCSV()   // exports it
IGObserve.reset()         // clears saved progress
IGObserve.stop()          // removes the hooks
```

Progress saves to `localStorage` continuously, so you can reload or finish across several sittings.

**Scroll both lists all the way down.** The panel shows `captured / total`. If you stop early, everyone you didn't capture looks like they don't follow you back — `diff()` warns when the counts are short, and there's a test pinning that hazard.

The observer also captures the live client headers (`x-ig-www-claim`, `x-asbd-id`, …) for the unfollow script to replay. That closes the header-fingerprint gap I opened by stripping them.

---

## 2. `ig-unfollow.js` — the write path

**This sends writes, and writes are what draw action blocks.** It reads the list the observer produced; it never scrapes.

Loading it prints a plan and does nothing else:

```js
IGUnfollow.CONFIG.TARGET_USERNAME = 'your_handle';   // required — it refuses to run without this
IGUnfollow.plan()                                    // review before arming anything
IGUnfollow.CONFIG.WHITELIST = ['someone'];
IGUnfollow.CONFIG.DRY_RUN = false;
await IGUnfollow.unfollowAll();
```

`TARGET_USERNAME` has no default on purpose. A script that writes should never act on "whoever happens to be logged in", so it hard-errors until you name the account. The read-only scripts fall back to the logged-in account with a warning.

| Setting | Default | Effect |
|---|---|---|
| `DRY_RUN` | `true` | refuses to send |
| `SKIP_VERIFIED` | `true` | spares verified accounts using the flag the observer captured — **costs no extra requests** |
| `CHECK_FOLLOWER_COUNT` | `false` | the old ">10k followers" rule; needs one extra GET per candidate, so it's off |
| `MAX_UNFOLLOWS_PER_RUN` | `15` | ceiling per sitting |
| `DELAY_MS` | `[45s, 120s]` | random gap between unfollows |
| `BATCH_PAUSE_MS` | 20 min | after every 5 |

Completed users are recorded by `pk`, so a re-run never double-unfollows. Any checkpoint, throttle, or auth failure is a **hard stop** — no retry.

Honest take: 15 unfollows per sitting over several days is survivable; doing this at all on a freshly flagged account is not something I'd recommend. Unfollowing by hand in the app carries no automation risk.

---

## 3. `ig-follow-check.js` — deprecated

The original active scraper. Kept for reference and still the only script that fetches lists without manual scrolling. It now detects checkpoints and hard-stops instead of retrying, and checkpoints every page so a failure doesn't discard collected data (`IGCheck.resume()`).

**Use `ig-observe.js` instead.** This one is what triggered the lock.

---

## If you get `checkpoint_required` again

1. Open the `checkpoint_url` (or just load instagram.com — it redirects).
2. Complete the verification: confirm it was you, enter the email/SMS code.
3. If Instagram asks you to change your password, do it.
4. Leave all of this alone for at least 24–48 hours.

Retrying while checkpointed makes it worse. All three scripts now stop dead on this rather than backing off and retrying.

---

## A lower-risk alternative worth knowing

Instagram's **Download Your Information** export (Settings → Accounts Center → Your information and permissions → Download your information → Followers and following, JSON) gives you `followers_1.json` and `following.json` directly. Officially supported, zero API calls, zero detection surface. Diffing two local files carries no risk at all. The only cost is waiting for the export.

If you ever get flagged again, switch to this.

---

## Tests

```
node --test
```

134 tests across all three scripts — URL matching, list diffing by `pk`, header capture (asserting cookies are never captured), count parsing, skip/plan logic, CSV escaping, backoff, and error-body classification. Includes regression tests built from the real `checkpoint_required` body that locked this account, and one pinning the incomplete-capture hazard.

Network and DOM paths aren't covered; they need a live authenticated session.

## Caveats

- Automating Instagram is against their Terms of Use. I called reading "low-risk" before this account was locked from reading alone — that was wrong.
- Private endpoints change without notice. If a call starts 404ing, the route moved; watch the Network tab while loading your own followers list and update the path.
- `ig-observe.js` depends on Instagram using `fetch`/`XHR` for list loading. If they move to something else, the panel will simply stay at zero — it won't break the page.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 FIWB Solutions LLC. Author: Joshua Gonzales.

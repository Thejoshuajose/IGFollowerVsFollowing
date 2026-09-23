# AGENTS.md — IGFollowerVsFollowing

Guidance for any AI coding agent working in this repository.

**Owner:** FIWB Solutions LLC · **Author:** Joshua Gonzales · **License:** MIT

## What this is

Three standalone browser-console scripts that identify which Instagram accounts a user follows that do not follow back. No build step, no dependencies, no bundler. Each script is pasted whole into Chrome DevTools on `www.instagram.com`.

## Stack

- Plain ES5-compatible JavaScript in an IIFE. **No transpiler, no imports, no bundler.** Each file must paste directly into a browser console and run as-is.
- Node's built-in test runner (`node --test`). No test framework dependency — `node_modules/` stays empty.
- Node >= 18.

## Commands

```bash
npm test          # or: node --test
```

There is no build, lint, or start command. Do not add one unless asked.

## Architecture

| File | Sends requests? | Role |
|---|---|---|
| `ig-observe.js` | **No** | Wraps the page's `fetch`/`XHR`, reads list responses the real client makes while the user scrolls |
| `ig-unfollow.js` | Yes, writes | Consumes the observer's saved list; never scrapes |
| `ig-follow-check.js` | Yes, many reads | **Deprecated.** The original active scraper — this is what got the original account locked |

Each `*.js` has a matching `*.test.cjs`.

Data flows one way: `ig-observe.js` writes `igobserve:notFollowingBack` to `localStorage`; `ig-unfollow.js` reads it. The observer also captures live client headers (`x-ig-www-claim`, `x-asbd-id`) that the unfollow script replays.

## Conventions

- **Dual-target module pattern.** Every script ends with `if (typeof module !== 'undefined' && module.exports)` for tests, `else if (typeof window !== 'undefined')` to auto-run in the browser. Preserve this — it is what makes the logic testable without a DOM.
- **Pure helpers are exported on `_pure`** for tests. New testable logic goes there.
- Scripts are intentionally **self-contained**; some helper duplication across files is correct. Do not factor shared code into a module — it would break console pasting.
- ES5 syntax in script bodies (`var`, `function`). Tests may use modern syntax.
- Configuration lives in a `CONFIG` object at the top of each file.

## Hard constraints

Violating any of these is a regression even if tests pass.

1. **`ig-observe.js` must never issue a request.** It only wraps existing traffic. A feature needing a network call belongs in another file.
2. **`res.clone().json()` in the fetch hook is mandatory.** Reading the original body starves Instagram's own code and breaks the page UI.
3. **Checkpoints are never retried.** `checkpoint_required` means the account is flagged; retrying deepens the block. It must hard-stop and must never be classified as a throttle. Tests pin this — do not weaken them.
4. **`DRY_RUN` defaults to `true` in `ig-unfollow.js`.** Never change the default.
5. **`TARGET_USERNAME` defaults to `''` in `ig-unfollow.js`,** which makes it refuse to run. A write script must not act on whichever account happens to be logged in.
6. **Never capture or log cookies.** `pickClientHeaders` uses an allowlist, with a test asserting cookies stay out.
7. **Never commit exported follower data.** `.gitignore` covers `ig-*.csv` / `ig-*.json`.
8. **No personal handles or Instagram user IDs in committed code.** This repo is public; use placeholders in fixtures.

## Context worth knowing

The original account was checkpointed and **locked** on the first real run of `ig-follow-check.js`, from reading alone. Instagram detects on access *pattern*, not just rate — one endpoint hit 29 times with no image loads, no telemetry, and no idle gaps. Slowing down does not fix this. That is why the passive observer exists and why it is the recommended entry point.

When changing anything here, weigh detection risk explicitly. **Adding requests is a regression even if it makes a feature nicer.**

## Testing

Every behavior change ships with tests: happy path, edge cases, failure modes. Network and DOM paths are not covered — they need a live authenticated session. Test the pure logic on `_pure` and state plainly what remains unverified rather than implying full coverage.

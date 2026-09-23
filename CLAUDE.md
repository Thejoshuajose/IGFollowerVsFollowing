# CLAUDE.md — IGFollowerVsFollowing

Project-specific instructions for Claude. Global standards in `~/.claude/CLAUDE.md` still apply.

**Owner:** FIWB Solutions LLC · **Author:** Joshua Gonzales · **License:** MIT

## What this is

Three standalone browser-console scripts that identify which accounts a user follows that do not follow back. No build step, no dependencies, no bundler. Each script is pasted whole into Chrome DevTools on `www.instagram.com`.

## Stack

- Plain ES5-compatible JavaScript in an IIFE. **No transpiler, no imports.** Each file must paste directly into a console and run.
- Node's built-in test runner (`node --test`) for the pure logic. No test framework dependency — `node_modules/` should stay empty.
- Node >= 18.

## Commands

```bash
npm test          # or: node --test
```

There is no build, lint, or start command. Do not add one without being asked.

## Architecture

| File | Sends requests? | Role |
|---|---|---|
| `ig-observe.js` | **No** | Wraps the page's `fetch`/`XHR`, reads list responses the real client makes while the user scrolls |
| `ig-unfollow.js` | Yes, writes | Consumes the observer's saved list; never scrapes |
| `ig-follow-check.js` | Yes, many reads | **Deprecated.** The original active scraper — this is what got the account locked |

Each `*.js` has a matching `*.test.cjs`.

## Conventions

- **Dual-target module pattern.** Every script ends with `if (typeof module !== 'undefined' && module.exports)` for tests, `else if (typeof window !== 'undefined')` to auto-run in the browser. Preserve this — it's what makes the logic testable without a DOM.
- **Pure helpers are exported on `_pure`** for the tests. Any new logic worth testing goes there.
- Scripts are intentionally **self-contained** — some helper duplication across files is correct. Do not factor shared code into a module; it would break console pasting.
- ES5 syntax in the script bodies (`var`, `function`). Tests may use modern syntax.
- Config lives in a `CONFIG` object at the top of each file.

## Hard constraints

- **`ig-observe.js` must never issue a request.** It only wraps. If you add a feature that needs a network call, it belongs in a different file.
- **`res.clone().json()` in the fetch hook is mandatory.** Reading the original body starves Instagram's own code and breaks the page UI.
- **Checkpoints are never retried.** `checkpoint_required` means the account is flagged; retrying deepens the block. It must hard-stop, and must never be classified as a throttle. There are tests pinning this — don't weaken them.
- **`DRY_RUN` defaults to `true` in `ig-unfollow.js`.** Never flip the default.
- Never capture or log cookies. `pickClientHeaders` has an allowlist and a test asserting cookies stay out of it.
- Never commit exported follower data — `.gitignore` covers `ig-*.csv` / `ig-*.json`.

## Context worth knowing

The account was checkpointed and **locked** on the first real run of `ig-follow-check.js`, from reading alone. Instagram detects on access *pattern*, not just rate — one endpoint hit 29 times with no image loads, no telemetry and no idle gaps. Slowing down does not fix this; that's why the passive observer exists.

When changing anything here, weigh detection risk explicitly. Adding requests is a regression even if it makes a feature nicer.

## Testing

Every behavior change ships with tests. Network and DOM paths aren't covered (they need a live authenticated session) — test the pure logic on `_pure` and say plainly what remains unverified.

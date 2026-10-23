# AGENTS.md — DeskMind harness

Instructions for coding agents (Codex, Claude Code) and reviewers working in this repo. [README.md](README.md) describes
the layers (runtime, skills, executor, local models) and the three gates.

## Running the tests

- `pnpm install` (the registry is npmmirror, see `.npmrc`), then `pnpm typecheck` and `pnpm test` (vitest).
- Tests use scripted models and the simulated desktop (`src/executor/sim.ts`). They need no network, no model key,
  and no real Mac.

## Rules for this repo

- **The three gates come first:**
  - zero false completions;
  - zero unconsented changes or sends;
  - the user can stop at any time, with rollback.

  A change that weakens one is a bug, however rare the case.
- **Models judge, code guards.** No regex or keyword rules over the user's words. When a decision needs more
  information, add a structured field to a role's schema. Regex is only for normalisation and formats.
- **Every judge call in the executor goes through `choose`.** Nothing is called after a stop, and a stop aborts calls
  in flight.
- **Store before forwarding.** A record the session depends on (for example `task_respond`, or a task's terminal
  record) is stored before it is acted on. If a terminal record can't be stored, the process halts, and recovery
  fills it in when the session next opens.
- **Harness changes are experiments.** For a role swap or a policy change, state the hypothesis, do a dev run (cheap
  model first), compare by group, and put the numbers in the commit. The check set stays frozen.

## How we change code here (shared across deskmind-ai repos)

These rules come from the review rounds of hands#62 and deskmind#107 (10-22/23). In those rounds the same family of bug
was patched one case at a time for many rounds, until the fix was redesigned around where the fact really lives.

### Before writing a fix

- **Write the invariant first.** State, in one sentence in the PR description, what must always hold. For example:
  "a key the user typed into a task's app is never counted less than main counts it", or "every process the helper
  runs ends up on the current key". Then turn it into a test that checks it across many cases: a table against the
  old behaviour, or random interleavings. Don't rely only on one test per reported scenario.
- **List the states.** For anything with a lifecycle (a process, a watch, a request, a session), write down every
  state it passes through, from created to registered, started, stored, ending, closing and gone. For each reader of
  that thing, say what it sees in each state. Most of the bugs in those rounds were one state a reader forgot.
- **Stop patching after the second bug of a family.** When a review finds a second case of the same kind of bug, stop
  adding cases. Find the fact's source of truth and derive from it:
  - The side that owns a fact reports it. The other side doesn't keep its own record of what it thinks happened.
  - Derive related values from a single read. Example: a process's environment and the digest reported for it come
    from the same read of the file.
  - Register first, then read. An item becomes visible to readers before it reads the data that can change under it.
  - Record something as done only after the other side confirmed it. A failed or unanswered request stays owed and
    is retried.
- **Classify every finding before working on it.**
  - A **bug** is any of: a gate breaks (a false completion, an unconsented change or send, no stop or rollback); a
    core function no longer works; a crash or hang; a regression; two checks that contradict each other. Bugs are
    always fixed.
  - An **effect** is friction: an extra card, an extra stale, slowness, wording. Effects are rated and recorded in
    deskmind#90 for later.
  - A state that can stay wrong forever, like a session left on a revoked key, is a bug. That holds even if the first
    example you find looks harmless.

### Adding a mechanism is where new bugs come from

When a fix adds a cache, a lock, a wait, a shared object or a retry, go through this list:

- **Cache.** Only cache success, never a failure. Something must invalidate the entry, for example a reused pid needs
  its start time checked. When an entry is reused, recheck that it still matches what holds now (permissions, an
  enabled tap, a live thread).
- **Shared or process-wide object.** Check whether state leaks from one user to the next, and check its health on
  every reuse. Never set a process-wide setting to fix one caller.
- **Wait.** A wait is always bounded. Never wait for work that is queued on the queue you are running on.
- **Lock.** Never hold a lock across a callback, IO or a run loop. Keep one lock order.
- **Teardown.** A thread that arrives late must find out that it was given up and return. Stopping twice is harmless.
- **Retry.** A retry is bounded or backed off. A record of success is written only after the whole job succeeded.

### Tests

- A new regression test must fail on the previous head. Say so in the PR or the commit.
- Fakes model the real lifecycle and the real failure replies. That includes the window between spawn and start, a
  lost or refused request, and a service that checks credentials. A fake that skips a state hides the bug in that
  state.
- A property test's oracle comes from the simulated ground truth. It must not repeat the implementation's own
  algorithm.
- For changes that involve threads or concurrency, run the suite several times in parallel under load. Use a race
  detector if one exists for the language.

### PRs and review rounds

- **One PR, one invariant.** When a second concern shows up, such as a new ownership question or a new sync problem,
  split it into its own PR.
- **One round fixes the whole family.** Fix every finding of a review round together. Before pushing, grep for other
  places with the same pattern and fix them in the same round.
- **Our re-reviews look only at what changed since the last reviewed head.** The external review covers the whole PR.
  Don't run two reviews on different heads at the same time.
- **Merging into main needs the `reviewed` label.** Merge with `--merge` at the reviewed head
  (`--match-head-commit`), after posting a review record on the PR.

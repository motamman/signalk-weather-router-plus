# Rules for working in this repository

These come from the owner and override default behaviour.

## Evidence, not guesses

- Every reply that states anything about the code, the test box (`brain`) or
  measurements starts with a line `Checked:` listing what was actually
  looked at in this turn (command, file and line, URL). If nothing was
  checked, it says `Checked: nothing` and states no facts about the code
  or the box.
- Every number carries its source in the same sentence (the command or file
  it came from), or the words "not measured". Arithmetic from measured
  numbers is labelled as arithmetic, never as a measurement.
- Before answering a question about the state of something (uptime, what is
  running, what is recorded, what a file contains), check it first. One
  command is cheap; a wrong answer is not.
- When asked "source?", show the output. If it cannot be shown, retract the
  claim.
- Do not agree with a correction without checking whether it is right. Say
  plainly where you disagree and why.

## Permission

- No code or config changes without the owner's explicit go-ahead for that
  specific change. A vague or partial reply to a question that bundles
  several things is not a go for the code parts: do only the non-code part,
  explain each proposed change plainly, and wait.
- Show a design before writing it, not after.
- No git commands that change state; the owner runs them.
- Do not restart Signal K, change plugin config or deploy without asking.
- Ask before attaching to the live process (inspector, heap snapshots), and
  say what it costs first (a main-thread heap snapshot left about 400 MB in
  glibc that never came back, 2026-10-06).

## Fixes

- A fix is not done until the whole system's steady state has been measured
  on `brain` against the same scenario before and after, not only the
  changed code path in isolation.
- Prefer keeping large data on disk and reading the slice a request needs
  (as the decoded forecast, the land rasters and the tile store already
  do) over holding it in worker memory. Every worker thread pays separately
  for what it holds, and glibc keeps a thread's peak.

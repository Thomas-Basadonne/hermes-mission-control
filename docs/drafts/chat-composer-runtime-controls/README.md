# DRAFT — Runtime controls inside the chat composer

**Status: abandoned / incomplete / NOT verified. Do not apply as a finished feature.**

## Original idea

Move provider + model and a separate reasoning selector into the ChatComposer footer, replacing the visible keyboard-shortcut hint. Narrow composers would use two rows, reserving Pause and Send at the right. Text-only controls, typographic hierarchy, amber reasoning, searchable model picker and recent selections.

## Why it was stopped

The existing statusline immediately above the composer already displays model and reasoning. Adding a second runtime control row is unnecessary. The accepted replacement is to make those existing statusline fields interactive, keep the provider explicit inside the model picker / tooltip, and leave Pause / Send geometry unchanged.

## What is archived

- `composer-attempt.patch`: tracked frontend edits made during the interrupted attempt, relative to the repository HEAD at archival time. Excludes pre-existing backend changes.
- `files/`: untracked component, helpers, tests, and debug probes from that attempt, saved with `.draft.txt` suffixes so they cannot be compiled or picked up by the test runner.

The interrupted subagent did not finish the model picker component. Its helper contains debug logging and is not production-ready. The attempted reasoning capability map is provisional, not authoritative provider capability metadata. The composer attempt was not build-verified or live-verified.

## Recovery / reuse

Read this note before applying anything. The patch is a historical snapshot, not a migration. Reuse only independently validated pieces; never apply it over the statusline implementation wholesale. No commit or push was made for this draft.

# Mission Control source freshness contract

`useMissionControl()` exposes `sources`, a per-endpoint map for `machine`, `sessions`, `cron`, `alerts`, `snapshot`, `tools`, and `skills`. Each entry is a `MissionControlSourceStatus`:

- `state`: `loading`, `live`, `fallback`, or `error` for the most recent attempt. Detected endpoint failures may be `error` while the displayed payload remains marked as fallback/previous data.
- `source`: API provenance such as `mission-control-sessions`, `gateway-status-fallback`, or `fallback`.
- `lastAttemptAt`: ISO timestamp for the most recent request attempt.
- `lastSuccessAt`: ISO timestamp of the most recent successful live response; errors and fallback results do not advance it.
- `error`: latest thrown error message, otherwise `null`.

A valid empty response is `live`, not `fallback`: for example, an empty sessions list or cron list from its endpoint replaces displayed data. A failed/fallback attempt does not overwrite previously successful displayed data. Consumers can distinguish current data from last-known-good data by checking `sources[name].state` and `source`; when state is `fallback` or `error` and `lastSuccessAt` is present, visible values are retained last-known-good data. If no successful response exists, the initial fallback remains visible but has no `lastSuccessAt`.

The legacy `lastUpdatedAt` remains for compatibility and advances only when the current refresh has at least one live source. Dashboard components should use per-source `lastAttemptAt` and `lastSuccessAt` for freshness labels.

The API snapshot types add optional `dataSource` and `dataError` fields. Existing loader signatures and data fields remain compatible; callers that do not inspect these fields continue to receive the same snapshot types. `dataSource` is `fallback` when a loader returns its compatibility fallback, and a named endpoint source for a successful endpoint response, including a valid empty result. `dataError` is populated when the loader detects that an endpoint was unavailable or failed; the store reports that attempt as `error` while retaining last-known-good data.

Refresh attempts are sequence-guarded per source: a newer `refreshAll` invalidates older in-flight results only for sources included in that refresh. A source omitted by the newer refresh keeps its existing request current, so that request may still update the source status and displayed data when it completes. Tools and skills reference refreshes have their own sequence guard. The lifecycle test covers both included-source stale-response rejection and an omitted-source request completing after a newer poll.

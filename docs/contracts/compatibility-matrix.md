# Mission Control compatibility matrix

Capabilities are not a separate endpoint: they are read from the `capabilities`
field of `GET /api/local/mission-control/agents` (`loadMissionControlCapabilities`
in `src/lib/hermes-api.ts`). Traces come from
`GET /api/local/mission-control/agents/trace` and its SSE twin
`/api/local/mission-control/agents/trace/stream`.

| Backend behavior | Expected UI behavior |
|---|---|
| `/api/local/mission-control/agents` returns a `capabilities` object | Feature gating from server capabilities |
| `capabilities` missing, or the agents request fails (non-auth error) | Fallback to built-in v1 capabilities |
| SSE stream works with `event: trace` | Live stream consumed with named listener |
| SSE stream only emits default message events | Live stream consumed via `onmessage` fallback |
| SSE stream unavailable | Automatic polling fallback |
| Trace payload direct shape | Normalized directly |
| Trace payload wrapped under `trace`, `data`, or `payload` | Unwrapped and normalized |
| `compact=1` unsupported | UI can skip compact mode via capabilities |
| Trace payload missing required fields | UI falls back to empty trace (no crash) |
| Agents request fails with 401 | Auth error is surfaced (no silent fallback) |

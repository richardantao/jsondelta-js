# Changelog

## 0.1.0 (unreleased)

Initial release.

### Protocol

- Four patch operations: `add`, `append`, `insert`, `complete`
- `complete` patches carry the fully assembled value snapshot at that path
- Dot-notation paths with array indices: `cards[0].term`
- Numbers, booleans, and null are always atomic — never emitted partially

### Emitter (Node)

- Single-pass FSM parser — no quadratic reparse, no buffering the full response
- Offset-based buffer scanning — plain string characters batched into one patch per token
- Full `\uXXXX` unicode escape decoding including surrogate pairs across token boundaries
- `pendingEscape` flag handles backslashes split across token boundaries
- Stack entries carry accumulated values for `complete` patch snapshots
- `completions` option (default `true`) — set `false` to suppress completion patches on high-throughput routes
- `root` option namespaces all emitted paths
- Middleware chain on the server side — resolve, filter, or transform before the wire

### Collector

- Reconstructs the object from patches via `setPath` / `getPath`
- `pathstart` event — fires once per path on first `add`/`insert`, value is the initial type
- `pathcomplete` event — fires on `complete` patches, value is the assembled snapshot from the Emitter
- `change` event — fires on every data patch with current partial state (shallow clone)
- `complete` event — fires when stream ends with fully assembled object
- Middleware chain on the client side
- `reset()` preserves middleware and listeners, clears state and seen paths

### React hook

- `useJsonPulse<T>()` wrapping a Collector instance
- `onPathStart`, `onPathComplete`, `onComplete`, `onError` callbacks as stable refs
- `status`: `'idle' | 'streaming' | 'complete' | 'error'`
- `consume`, `complete`, `reset` for transport wiring
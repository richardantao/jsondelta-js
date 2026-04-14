---
"jsoncurrent": minor
---

### Changed

- React subpath type renamed: `UseJsonPulseOptions` -> `UseJsonCurrentOptions`
- React subpath return type renamed: `UseJsonPulseReturn` -> `UseJsonCurrentReturn`
- Error class renamed: `JsonPulseError` -> `JsonCurrentError`

### Removed

- Legacy React subpath type names: `UseJsonPulseOptions`, `UseJsonPulseReturn`
- Legacy error class name: `JsonPulseError`

### Migration

- Update type imports from `jsoncurrent/react` to the new `UseJsonCurrent*` names.
- Replace any `instanceof JsonPulseError` checks with `instanceof JsonCurrentError`.

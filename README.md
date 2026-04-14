# jsoncurrent

Stream structured JSON from an LLM to your client — incrementally, as it generates.

```
LLM tokens → [Emitter] → patch stream → [Collector] → assembled object
```

---

## The problem

LLMs generate JSON token by token. If you wait for the complete response before showing anything, users stare at a spinner for seconds. But if you try to parse incomplete JSON — `{"title": "Quarterly Re`, `{"sections": [{"heading": "Ex` — standard parsers throw.

jsoncurrent solves this with a streaming patch protocol. The Emitter on your server parses raw LLM tokens as they arrive and converts them into structured patch operations. Each patch is a small JSON object describing exactly what changed. The Collector on your client applies those patches incrementally, giving you a live partially-assembled object you can render immediately.

```
// What the LLM emits (incomplete, unparseable mid-stream):
{"title": "Quarterly Report", "sections": [{"heading": "Exec

// What jsoncurrent delivers to your client as it arrives:
{ path: 'title',               value: 'Quarterly Report', op: 'add'    }
{ path: 'sections',            value: [],                 op: 'add'    }
{ path: 'sections[0]',         value: {},                 op: 'add'    }
{ path: 'sections[0].heading', value: 'Exec',             op: 'add'    }
{ path: 'sections[0].heading', value: 'utive Summary',    op: 'append' }
```

Your UI updates on every patch. By the time the LLM finishes, the object is already assembled.

---

## Why a server-side Emitter?

The Emitter runs on your server for one core reason.

**Server as participant.** Forwarding raw LLM output unchanged works when the model's output is exactly what the client needs. It breaks down when values require resolution before the client can use them:

- The model emits `{{img:cell-diagram}}` — your client needs a presigned S3 URL
- The model emits `[[source:42]]` — your client needs a resolved document title
- The model emits fields a given user has no permission to see
- The model emits dates in inconsistent formats that need normalising

The Emitter's middleware chain intercepts every patch before it hits the wire. Resolve, filter, transform — the client receives clean values, never the model's internal conventions.

```
LLM tokens → [Emitter + middleware] → resolved patch stream → [Collector] → UI
                      ↑
              resolve placeholders
              strip restricted fields
              inject database values
              normalise formats
```

---

## How tokens stream

Understanding how jsoncurrent handles different JSON types helps you reason about what your client receives mid-stream.

**Strings** stream incrementally — each token's worth of characters arrives as a patch. The first patch is `op: 'add'` (initialises the field), subsequent patches are `op: 'append'` (concatenates). Your UI can show text appearing character by character, or debounce to taste.

```
{ path: 'title', value: 'Quarterly ', op: 'add'    }  ← field initialised
{ path: 'title', value: 'Report',     op: 'append' }  ← characters appended
```

**Numbers are atomic** — they never arrive partially. `1997` will not appear as `1`, `19`, `199`, `1997`. The Emitter accumulates digits internally and emits the complete number only when it sees the terminating character. This means computed fields like `new Date(year)` are always safe.

**Booleans and null are atomic** — same as numbers. `true` is never `t` or `tr`.

**Objects** initialise immediately as `{}` when the opening `{` arrives, then fill in as their properties stream. You can render a skeleton the moment a section object starts and fill it progressively.

```
{ path: 'sections[0]',         value: {},                  op: 'add' }  ← section exists, empty
{ path: 'sections[0].heading', value: 'Executive Summary', op: 'add' }  ← heading arrives
```

**Arrays** initialise as `[]` when `[` arrives, then elements are pushed one by one via `op: 'insert'` or `op: 'add'` on indexed paths.

**Path notation** uses dots and brackets: `sections[0].content.text`. The Emitter builds these paths from the JSON structure automatically.

---

## The wire format

Four operations. This is the entire protocol.

| `op`       | Meaning                                      | Example                                                    |
|------------|----------------------------------------------|------------------------------------------------------------|
| `add`      | Initialise or replace a value at a path      | `{ path: 'title', value: 'Hello', op: 'add' }`            |
| `append`   | Concatenate a string delta                   | `{ path: 'title', value: ' World', op: 'append' }`        |
| `insert`   | Push a new element onto an array             | `{ path: 'tags', value: 'urgent', op: 'insert' }`         |
| `complete` | The value at this path is fully assembled    | `{ path: 'title', value: 'Hello World', op: 'complete' }` |

**Patches are plain JSON-serialisable objects.** jsoncurrent emits them on the server and expects to receive them on the client — how they travel is entirely up to you. The examples use SSE, but WebSocket, HTTP streaming, or any transport that carries text works identically. jsoncurrent has no opinion on framing, authentication, compression, or connection management.

`append` has no equivalent in JSON Patch (RFC 6902). It exists specifically for incremental string streaming.

`complete` signals that a path is fully assembled and will not receive further patches. The `value` field carries the fully assembled snapshot at that path — a deep clone, safe to store and render directly. This means you can skip `change` events entirely for paths where you only care about the final value:

```typescript
// Skip incremental updates for sections — only render when each section is complete
collector.on('patch', (chunk) => {
  if (chunk.op === 'complete' && /^sections\[\d+\]$/.test(chunk.path)) {
    appendSection(chunk.value);
  }
});
```

Disable completion patches on routes where the lifecycle events are not used: `new Emitter({ completions: false })`.

### The path lifecycle

Every path passes through three observable moments:

```
pathstart    → first patch arrives, value is the initial type ({}, [], or first chars)
change       → fires on every data patch as the value builds
pathcomplete → value is sealed, stable snapshot delivered
```

---

## Installation

```bash
npm install jsoncurrent
```

If you use the React hook entrypoint, install React 19 or newer as well:

```bash
npm install react@^19
```

`react` is an optional peer dependency and is only required for `jsoncurrent/react`.

For the Python implementation, see [jsoncurrent-py](https://github.com/richardantao/jsoncurrent-py).

---

## Node server (Emitter)

```typescript
import { Emitter } from 'jsoncurrent';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

app.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');

  const emitter = new Emitter();

  // Serialise each patch and send over SSE — the client owns deserialisation
  emitter.on('patch', (chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  });

  emitter.on('complete', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'Generate a structured report as JSON...' }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      emitter.write(event.delta.text);
    }
  }

  emitter.flush();
});
```

### Disabling completions

If `pathstart` / `pathcomplete` are not used on a route, disable completion patches to reduce wire overhead:

```typescript
const emitter = new Emitter({ completions: false });
```

---

## JS/TS client (Collector)

The Collector is transport-agnostic. `consume()` expects a `StreamingChunk` object — deserialise from your transport before calling it.

```typescript
import { Collector } from 'jsoncurrent';

const collector = new Collector<ReportDocument>();

collector.on('change', (state) => {
  // Every data patch — state is the current partially-assembled object
  setReport(state);
});

collector.on('complete', (final) => {
  // Once, when the stream ends
  save(final);
});

// Wire to SSE — deserialise each message before feeding to the Collector
const source = new EventSource('/stream');

source.onmessage = (event) => {
  if (event.data === '[DONE]') {
    collector.complete();
    source.close();
    return;
  }
  collector.consume(JSON.parse(event.data)); // ← deserialise from your transport
};
```

### Path lifecycle events

```typescript
// Fires once when a path first receives a patch
collector.on('pathstart', (path, value) => {
  if (/^sections\[\d+\]$/.test(path)) showSectionSkeleton(path);
});

// Fires when a path is fully sealed — value is a deep snapshot, safe to store
collector.on('pathcomplete', (path, value) => {
  if (/^sections\[\d+\]$/.test(path)) replaceSkeletonWithSection(value);
});
```

Both values are deep-snapshotted at emission — you receive a stable copy, not a live reference.

### Middleware

```typescript
const collector = new Collector<ReportDocument>();

// Mirror summary → originalSummary as it streams
collector.use((patch, next) => {
  next(patch);
  if (patch.path.endsWith('.summary')) {
    next({ ...patch, path: patch.path.replace('.summary', '.originalSummary') });
  }
});
```

Middleware runs in registration order. Call `next(patch)` to pass through, `next` multiple times to fan out, or return without calling `next` to drop. Middleware sees all four ops including `complete`.

---

## React hook

```typescript
import { useJsonCurrent } from 'jsoncurrent/react';

function ReportGenerator({ documentId }: { documentId: string }) {
  const { data, status, consume, complete, reset } = useJsonCurrent<ReportDocument>({
    onPathStart: (path) => {
      if (/^sections\[\d+\]$/.test(path)) showSkeleton(path);
    },
    onPathComplete: (path, value) => {
      if (/^sections\[\d+\]$/.test(path)) replaceSkeleton(path, value);
    },
    onComplete: (final) => save(final),
  });

  useEffect(() => {
    reset();
    const source = new EventSource(`/api/documents/${documentId}/stream`);
    source.onmessage = (event) => {
      if (event.data === '[DONE]') { complete(); source.close(); return; }
      consume(JSON.parse(event.data)); // ← deserialise from your transport
    };
    return () => source.close();
  }, [documentId]);

  return (
    <div>
      <h1>{data.title}</h1>
      {data.sections?.map((section, i) => (
        <SectionCard key={i} heading={section.heading} content={section.content} />
      ))}
      {status === 'streaming' && <Spinner />}
    </div>
  );
}
```

---

## Collector API

```typescript
const collector = new Collector<T>();

collector.use(fn: MiddlewareFn): this          // register middleware — chainable
collector.consume(chunk: StreamingChunk): void  // feed a deserialised patch
collector.complete(): void                      // signal end of stream
collector.reset(): this                         // reset state, preserve middleware + listeners
collector.value: Partial<T>                     // current partially-assembled state

collector.on('change',       (state: Partial<T>) => void)
collector.on('complete',     (state: T) => void)
collector.on('pathstart',    (path: string, value: unknown) => void)
collector.on('pathcomplete', (path: string, value: unknown) => void)
collector.on('error',        (err: JsonCurrentError) => void)
```

## Emitter API

```typescript
const emitter = new Emitter({
  root?: string;         // namespace prefix for all emitted paths
  completions?: boolean; // emit complete patches — default true
});

emitter.write(token: string): void  // feed a raw LLM token
emitter.flush(): void               // end of stream — flushes, emits 'complete', resets
emitter.reset(): void               // reset without emitting 'complete'
emitter.use(fn: MiddlewareFn): this // register middleware — chainable

emitter.on('patch',    (chunk: StreamingChunk) => void)
emitter.on('complete', () => void)
emitter.on('error',    (err: JsonCurrentError) => void)
```

---

## React hook API

```typescript
const { data, status, consume, complete, reset } = useJsonCurrent<T>({
  middleware?:     MiddlewareFn[];
  onPathStart?:    (path: string, value: unknown) => void;
  onPathComplete?: (path: string, value: unknown) => void;
  onComplete?:     (state: T) => void;
  onError?:        (err: Error) => void;
});

// data:     Partial<T>   — current assembled state, updated on every patch
// status:   StreamStatus — 'idle' | 'streaming' | 'complete' | 'error'
// consume:  (chunk) => void — feed a deserialised patch from your transport
// complete: () => void   — signal end of stream
// reset:    () => void   — clear state and return to idle
```

---

## Middleware signature

```typescript
type MiddlewareFn = (
  patch: StreamingChunk,
  next: (patch: StreamingChunk) => void
) => void;
```

Registered on the Emitter (server, before the wire), the Collector (client, before reconstruction), or both.

---

## StreamingChunk type

```typescript
// All four ops share the same shape — value carries the assembled snapshot for 'complete'
interface StreamingChunk {
  path:  string;
  value: unknown;
  op:    'add' | 'append' | 'insert' | 'complete';
}
```

For `complete` patches, `value` is the fully assembled snapshot at `path` — a deep clone of the assembled object, array, or primitive at the moment the value was sealed.

---

## Protocol stability

The wire format — `{ path, value, op }` with the four operations — is the stable public contract. Semver major bumps are required for any change to `StreamingChunk` shape, since that breaks interoperability across implementations.

The Emitter and Collector are reference implementations. A Swift Collector or Rust Emitter that speaks the same wire format is a first-class participant.

---

## See also

- [jsonriver](https://github.com/rictic/jsonriver) — client-side incremental JSON parsing for pure JS stacks where the server forwards the raw LLM stream unchanged
- [Anthropic streaming docs](https://docs.anthropic.com/en/api/messages-streaming)
- [OpenAI streaming docs](https://platform.openai.com/docs/api-reference/streaming)

---

## License

MIT
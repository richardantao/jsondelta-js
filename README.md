# jsoncurrent

Transport-agnostic patch protocol for streaming incremental JSON.

```
tokens → [Emitter] → patch stream → [Collector] → assembled object
```

**Python backend?** Use the Python Emitter: [https://github.com/richardantao/jsoncurrent-py](https://github.com/richardantao/jsoncurrent-py)

## Installation

```bash
npm install jsoncurrent
```

---

## The problem

LLMs generate JSON token by token. But if you try to parse incomplete JSON mid-stream, standard parsers throw.

jsoncurrent solves this with a patch protocol. The Emitter on your server parses raw tokens as they arrive and emits structured patch operations. The Collector on your client applies them incrementally, giving you a live partially-assembled object you can render immediately.

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

---

## Why a server-side Emitter?

**Server as participant.** Forwarding raw LLM output unchanged breaks down when values require resolution before the client can use them:

- The model emits `{{img:chart}}` — your client needs a presigned S3 URL
- The model emits fields a given user has no permission to see
- The model emits dates in inconsistent formats that need normalising

The Emitter's middleware chain intercepts every patch before it hits the wire. Resolve, filter, transform — the client receives clean values, never the model's internal conventions.

---

## The wire format

Four operations. This is the entire protocol.

| `op`       | Meaning                                      | Example                                                    |
|------------|----------------------------------------------|------------------------------------------------------------|
| `add`      | Initialise or replace a value at a path      | `{ path: 'title', value: 'Hello', op: 'add' }`            |
| `append`   | Concatenate a string delta                   | `{ path: 'title', value: ' World', op: 'append' }`        |
| `insert`   | Push a new element onto an array             | `{ path: 'tags', value: 'news', op: 'insert' }`           |
| `complete` | The value at this path is fully assembled    | `{ path: 'title', value: 'Hello World', op: 'complete' }` |

Paths use dot-notation with array indices: `sections[0].heading`.

**Patches are plain JSON-serialisable objects.** How they travel is entirely up to you — SSE, WebSocket, HTTP streaming, or any transport that carries text. jsoncurrent has no opinion on framing, authentication, or connection management.

`complete` patches carry the fully assembled value snapshot — safe to store and render directly without waiting for the full stream to finish.

### Path lifecycle

Every path passes through three observable moments:

```
pathstart    → first patch arrives — value is the initial type ({}, [], or first chars)
change       → fires on every data patch as the value builds
pathcomplete → value is sealed — stable snapshot delivered
```

---

## Node server (Emitter)

```typescript
import { Emitter } from 'jsoncurrent';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

app.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');

  const emitter = new Emitter();
  emitter.on('patch', (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`));
  emitter.on('complete', () => { res.write('data: [DONE]\n\n'); res.end(); });

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'Generate a report as JSON...' }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      emitter.write(event.delta.text);
    }
  }

  emitter.flush();
});
```

### Middleware

```typescript
const emitter = new Emitter();

emitter.use((patch, next) => {
  // Resolve image placeholders before they reach the client
  if (patch.op === 'add' && typeof patch.value === 'string' && patch.value.startsWith('{{img:')) {
    const filename = patch.value.slice(6, -2);
    return next({ ...patch, value: getPresignedUrl(filename) });
  }
  // Drop internal fields
  if (patch.path.includes('internal')) return;
  next(patch);
});
```

---

## JS/TS client (Collector)

`consume()` expects a `StreamingChunk` object — deserialise from your transport before calling it.

```typescript
import { Collector } from 'jsoncurrent';

const collector = new Collector<Report>();

collector.on('change', (state) => renderReport(state));
collector.on('complete', (final) => save(final));

// Path lifecycle — show skeletons as sections start, replace when complete
collector.on('pathstart', (path) => {
  if (/^sections\[\d+\]$/.test(path)) showSectionSkeleton(path);
});
collector.on('pathcomplete', (path, value) => {
  if (/^sections\[\d+\]$/.test(path)) replaceSkeletonWithSection(value);
});

const source = new EventSource('/stream');
source.onmessage = (event) => {
  if (event.data === '[DONE]') { collector.complete(); source.close(); return; }
  collector.consume(JSON.parse(event.data));
};
```

### Middleware

```typescript
collector.use((patch, next) => {
  next(patch);
  // Fan out — mirror heading → originalHeading as it streams
  if (patch.path.endsWith('.heading')) {
    next({ ...patch, path: patch.path.replace('.heading', '.originalHeading') });
  }
});
```

Middleware runs in registration order. Call `next(patch)` to pass through, multiple times to fan out, or return without calling `next` to drop. Receives all four ops including `complete`.

---

## React

```typescript
import { useJsonCurrent } from 'jsoncurrent/react';

function ReportViewer({ reportId }: { reportId: string }) {
  const { data, status, consume, complete, reset } = useJsonCurrent<Report>({
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
    const source = new EventSource(`/api/reports/${reportId}/stream`);
    source.onmessage = (event) => {
      if (event.data === '[DONE]') { complete(); source.close(); return; }
      consume(JSON.parse(event.data));
    };
    return () => source.close();
  }, [reportId]);

  return (
    <div>
      <h1>{data.title}</h1>
      {data.sections?.map((section, i) => <Section key={i} {...section} />)}
      {status === 'streaming' && <Spinner />}
    </div>
  );
}
```

---

## API reference

### Collector

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

### Emitter

```typescript
const emitter = new Emitter({
  root?: string;         // namespace prefix for all emitted paths
  completions?: boolean; // emit complete patches — default true
});

emitter.write(token: string): void  // feed a raw token
emitter.flush(): void               // end of stream — flushes, emits 'complete', resets
emitter.reset(): void               // reset without emitting 'complete'
emitter.use(fn: MiddlewareFn): this // register middleware — chainable

emitter.on('patch',    (chunk: StreamingChunk) => void)
emitter.on('complete', () => void)
emitter.on('error',    (err: JsonCurrentError) => void)
```

### React hook

```typescript
const { data, status, consume, complete, reset } = useJsonCurrent<T>({
  middleware?:     MiddlewareFn[];
  onChange?:       (state: Partial<T>) => void;
  onPathStart?:    (path: string, value: unknown) => void;
  onPathComplete?: (path: string, value: unknown) => void;
  onComplete?:     (state: T) => void;
  onError?:        (err: Error) => void;
});
```

---

## jsoncurrent-py

Running a Python backend? The Python Emitter speaks the same wire format — patches from a FastAPI or Flask server are **consumed** by the JS Collector without any changes on the client side.

[jsoncurrent-py](https://github.com/richardantao/jsoncurrent-py)

---

## See also

- [jsonriver](https://github.com/rictic/jsonriver) — client-side incremental JSON parsing for pure JS stacks where the server forwards the raw LLM stream unchanged and no server-side transformation is needed
- [Anthropic streaming docs](https://docs.anthropic.com/en/api/messages-streaming)
- [OpenAI streaming docs](https://platform.openai.com/docs/api-reference/streaming)

---

## License

MIT
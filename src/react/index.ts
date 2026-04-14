import {
	useCallback,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";

import { Collector } from "../collector";
import type { MiddlewareFn, StreamingChunk } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamStatus = "idle" | "streaming" | "complete" | "error";

export interface UseJsonPulseOptions<T> {
	/**
	 * Middleware functions applied to every patch before reconstruction.
	 * Runs in registration order. See MiddlewareFn for the full contract.
	 *
	 * @example Mirror summary → originalSummary
	 * middleware: [(patch, next) => {
	 *   next(patch);
	 *   if (patch.path.endsWith('.summary')) {
	 *     next({ ...patch, path: patch.path.replace('.summary', '.originalSummary') });
	 *   }
	 * }]
	 */
	middleware?: MiddlewareFn[];

	/**
	 * Called on every patch application with the latest assembled partial state.
	 * Equivalent to listening to the Collector's 'change' event.
	 */
	onChange?: (state: Partial<T>) => void;

	/**
	 * Called once when the stream ends with the fully assembled object.
	 * Equivalent to listening to the Collector's 'complete' event.
	 */
	onComplete?: (state: T) => void;

	/**
	 * Called the first time any path receives a data patch within this stream.
	 * Fires once per path regardless of how many subsequent patches arrive.
	 * Resets when `reset()` is called.
	 *
	 * Use this to react immediately when a new value begins streaming —
	 * e.g. show a skeleton while it builds.
	 *
	 * @example
	 * onPathStart: (path, value) => {
	 *   if (/^sections\[\d+\]$/.test(path)) showSectionSkeleton(path);
	 * }
	 */
	onPathStart?: (path: string, value: unknown) => void;

	/**
	 * Called each time a value at any path is fully assembled.
	 * Fires before the stream-level `onComplete`.
	 *
	 * The consumer is responsible for filtering by path pattern.
	 *
	 * @example Render each section as soon as it's sealed
	 * onPathComplete: (path, value) => {
	 *   if (/^sections\[\d+\]$/.test(path)) appendSection(value);
	 * }
	 *
	 * @example React to specific primitives completing
	 * onPathComplete: (path, value) => {
	 *   if (path === 'title') setTitle(value as string);
	 * }
	 */
	onPathComplete?: (path: string, value: unknown) => void;

	/**
	 * Called when an error occurs during patch application.
	 */
	onError?: (err: Error) => void;
}

export interface UseJsonPulseReturn<T> {
	/**
	 * The current partially-assembled state. Updated on every patch.
	 * `undefined` until the first patch arrives.
	 */
	data: Partial<T>;

	/** Current streaming status. */
	status: StreamStatus;

	/**
	 * Feed a single patch into the Collector.
	 * Call this for each chunk from your transport layer.
	 *
	 * @example SSE
	 * source.onmessage = (e) => {
	 *   if (e.data === '[DONE]') { complete(); return; }
	 *   consume(JSON.parse(e.data));
	 * };
	 */
	consume: (chunk: StreamingChunk) => void;

	/**
	 * Signal that the stream has ended.
	 * Triggers the 'complete' event and sets status to 'complete'.
	 */
	complete: () => void;

	/**
	 * Reset the Collector back to idle state.
	 * Clears data and status — middleware is preserved.
	 * Call this before starting a new generation.
	 */
	reset: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * React hook for consuming a jsonpulse patch stream.
 *
 * Wraps a Collector instance, exposing `consume` and `complete` for your
 * transport layer to call, and `data`/`status` for your component to render.
 * Transport is intentionally out of scope — wire it up however your app
 * connects: SSE, WebSocket, HTTP streaming, etc.
 *
 * @example Basic SSE usage
 * ```tsx
 * function ReportGenerator({ documentId }: { documentId: string }) {
 *   const { data, status, consume, complete, reset } = useJsonPulse<ReportDocument>();
 *
 *   useEffect(() => {
 *     reset();
 *     const source = new EventSource(`/api/stream/${documentId}`);
 *     source.onmessage = (e) => {
 *       if (e.data === '[DONE]') { complete(); source.close(); return; }
 *       consume(JSON.parse(e.data));
 *     };
 *     source.onerror = () => source.close();
 *     return () => source.close();
 *   }, [documentId]);
 *
 *   return (
 *     <div>
 *       <h1>{data.title ?? '...'}</h1>
 *       {data.sections?.map((section, i) => <SectionCard key={i} {...section} />)}
 *       {status === 'streaming' && <Spinner />}
 *     </div>
 *   );
 * }
 * ```
 *
 * @example With middleware
 * ```tsx
 * const { data, consume, complete } = useJsonPulse<ReportDocument>({
 *   middleware: [
 *     // Mirror summary → originalSummary as it streams
 *     (patch, next) => {
 *       next(patch);
 *       if (patch.path.endsWith('.summary')) {
 *         next({ ...patch, path: patch.path.replace('.summary', '.originalSummary') });
 *       }
 *     },
 *   ],
 *   onComplete: (final) => saveToServer(final),
 * });
 * ```
 */
export function useJsonPulse<T = unknown>(
	options: UseJsonPulseOptions<T> = {},
): UseJsonPulseReturn<T> {
	const [data, setData] = useState<Partial<T>>({});
	const [status, setStatus] = useState<StreamStatus>("idle");

	// Stable ref for the Collector instance — never recreated across renders.
	const collectorRef = useRef<Collector<T> | null>(null);

	// Middleware is only applied when a Collector is first created.
	const middlewareRef = useRef(options?.middleware);
	const onComplete = useEffectEvent((state: T) => {
		options.onComplete?.(state);
	});
	const onChange = useEffectEvent((state: Partial<T>) => {
		options.onChange?.(state);
	});
	const onError = useEffectEvent((err: Error) => {
		options.onError?.(err);
	});
	const onPathStart = useEffectEvent((path: string, value: unknown) => {
		options.onPathStart?.(path, value);
	});
	const onPathComplete = useEffectEvent((path: string, value: unknown) => {
		options.onPathComplete?.(path, value);
	});

	useEffect(() => {
		middlewareRef.current = options.middleware;
	});

	// Initialise Collector once.
	const getCollector = useCallback((): Collector<T> => {
		if (collectorRef.current) return collectorRef.current;

		const collector = new Collector<T>();

		middlewareRef.current?.forEach((fn) => {
			collector.use(fn);
		});

		collector.on("change", (state) => {
			setData(state);
			onChange(state);
		});

		collector.on("pathstart", (path, value) => {
			onPathStart(path, value);
		});

		collector.on("pathcomplete", (path, value) => {
			onPathComplete(path, value);
		});

		collector.on("complete", (final) => {
			setStatus("complete");
			onComplete(final);
		});

		collector.on("error", (err) => {
			setStatus("error");
			onError(err);
		});

		collectorRef.current = collector;
		return collector;
	}, []);

	const consume = useCallback(
		(chunk: StreamingChunk) => {
			const collector = getCollector();
			if (status === "idle") setStatus("streaming");
			try {
				collector.consume(chunk);
			} catch (err) {
				setStatus("error");
				onError(err instanceof Error ? err : new Error(String(err)));
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		},
		[status, getCollector],
	);

	const complete = useCallback(() => {
		collectorRef.current?.complete();
	}, []);

	const reset = useCallback(() => {
		if (collectorRef.current) {
			// Tear down the old collector so a fresh one is built on next consume()
			collectorRef.current.removeAllListeners();
			collectorRef.current = null;
		}
		setData({});
		setStatus("idle");
	}, []);

	return { data, status, consume, complete, reset };
}

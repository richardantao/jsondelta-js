import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useJsonPulse } from "../react";
import type { StreamingChunk } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const patch = (
	path: string,
	value: unknown,
	op: StreamingChunk["op"] = "add",
): StreamingChunk => ({ path, value, op });

// ---------------------------------------------------------------------------
// Basic state management
// ---------------------------------------------------------------------------

describe("useJsonPulse — status transitions", () => {
	it("starts idle", () => {
		const { result } = renderHook(() => useJsonPulse());
		expect(result.current.status).toBe("idle");
		expect(result.current.data).toEqual({});
	});

	it("transitions to streaming on first consume", () => {
		const { result } = renderHook(() => useJsonPulse());
		act(() => result.current.consume(patch("title", "Hello")));
		expect(result.current.status).toBe("streaming");
	});

	it("transitions to complete when complete() is called", () => {
		const { result } = renderHook(() => useJsonPulse());
		act(() => {
			result.current.consume(patch("title", "Hello"));
			result.current.complete();
		});
		expect(result.current.status).toBe("complete");
	});

	it("resets back to idle", () => {
		const { result } = renderHook(() => useJsonPulse());
		act(() => {
			result.current.consume(patch("title", "Hello"));
			result.current.complete();
		});
		act(() => result.current.reset());
		expect(result.current.status).toBe("idle");
		expect(result.current.data).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

describe("useJsonPulse — data assembly", () => {
	it("assembles patches into data", () => {
		const { result } = renderHook(() => useJsonPulse<{ title: string }>());
		act(() => result.current.consume(patch("title", "Hello")));
		expect(result.current.data.title).toBe("Hello");
	});

	it("appends string deltas", () => {
		const { result } = renderHook(() => useJsonPulse<{ title: string }>());
		act(() => {
			result.current.consume(patch("title", "Hel", "add"));
			result.current.consume(patch("title", "lo", "append"));
		});
		expect(result.current.data.title).toBe("Hello");
	});

	it("assembles nested paths", () => {
		const { result } = renderHook(() =>
			useJsonPulse<{ cards: { term: string }[] }>(),
		);
		act(() => {
			result.current.consume(patch("cards", [], "add"));
			result.current.consume(patch("cards[0]", {}, "add"));
			result.current.consume(patch("cards[0].term", "Mitosis", "add"));
		});
		expect(result.current.data.cards?.[0]?.term).toBe("Mitosis");
	});

	it("each change produces a new data reference for React diffing", () => {
		const { result } = renderHook(() => useJsonPulse<{ n: number }>());
		const refs: object[] = [];

		// Capture refs via re-renders
		act(() => result.current.consume(patch("n", 1)));
		refs.push(result.current.data as object);
		act(() => result.current.consume(patch("n", 2, "add")));
		refs.push(result.current.data as object);

		expect(refs[0]).not.toBe(refs[1]);
	});
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

describe("useJsonPulse — middleware", () => {
	it("applies middleware before reconstruction", () => {
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({
				middleware: [
					(patch, next) =>
						next({ ...patch, value: (patch.value as string).toUpperCase() }),
				],
			}),
		);
		act(() => result.current.consume(patch("title", "hello")));
		expect(result.current.data.title).toBe("HELLO");
	});

	it("can drop patches via middleware", () => {
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string; secret: string }>({
				// Drop any patch at path 'secret'
				middleware: [
					(p, next) => {
						if (p.path !== "secret") next(p);
					},
				],
			}),
		);
		act(() => {
			result.current.consume(patch("title", "Hello"));
			result.current.consume(patch("secret", "password"));
		});
		expect(result.current.data.title).toBe("Hello");
		expect(
			(result.current.data as Record<string, unknown>).secret,
		).toBeUndefined();
	});

	it("can fan out a patch to mirror a field", () => {
		const { result } = renderHook(() =>
			useJsonPulse<{ cards: { term: string; originalTerm: string }[] }>({
				middleware: [
					(p, next) => {
						next(p);
						if (p.path.endsWith(".term")) {
							next({ ...p, path: p.path.replace(".term", ".originalTerm") });
						}
					},
				],
			}),
		);
		act(() => {
			result.current.consume(patch("cards", [], "add"));
			result.current.consume(patch("cards[0]", {}, "add"));
			result.current.consume(patch("cards[0].term", "Mitosis", "add"));
		});
		expect(result.current.data.cards?.[0]?.term).toBe("Mitosis");
		expect(result.current.data.cards?.[0]?.originalTerm).toBe("Mitosis");
	});
});

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

describe("useJsonPulse — callbacks", () => {
	it("calls onChange with the latest partial state on each patch", () => {
		const onChange = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onChange }),
		);

		act(() => {
			result.current.consume(patch("title", "Hello"));
			result.current.consume(patch("title", "!", "append"));
		});

		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ title: "Hello!" }),
		);
	});

	it("calls onComplete with final state", () => {
		const onComplete = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onComplete }),
		);
		act(() => {
			result.current.consume(patch("title", "Hello"));
			result.current.complete();
		});
		expect(onComplete).toHaveBeenCalledOnce();
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Hello" }),
		);
	});

	it("does not call onComplete if complete() never called", () => {
		const onComplete = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onComplete }),
		);
		act(() => result.current.consume(patch("title", "Hello")));
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("sets status to error when consume throws after complete", () => {
		const onError = vi.fn();
		const { result } = renderHook(() => useJsonPulse({ onError }));
		act(() => {
			result.current.consume(patch("x", 1));
			result.current.complete();
		});
		// Consuming after complete — Collector throws, hook catches and routes to error
		act(() => result.current.consume(patch("x", 2)));
		expect(result.current.status).toBe("error");
		expect(onError).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// pathcomplete
// ---------------------------------------------------------------------------

describe("useJsonPulse — pathstart", () => {
	it("calls onPathStart the first time a path receives a patch", () => {
		const onPathStart = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onPathStart }),
		);
		act(() => {
			result.current.consume(patch("title", "Hello", "add"));
		});
		expect(onPathStart).toHaveBeenCalledOnce();
		expect(onPathStart).toHaveBeenCalledWith("title", "Hello");
	});

	it("does not call onPathStart on append — only on first add", () => {
		const onPathStart = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onPathStart }),
		);
		act(() => {
			result.current.consume(patch("title", "Hel", "add"));
			result.current.consume(patch("title", "lo", "append"));
			result.current.consume(patch("title", "!", "append"));
		});
		expect(onPathStart).toHaveBeenCalledOnce();
	});

	it("fires before pathcomplete for the same path", () => {
		const events: string[] = [];
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({
				onPathStart: (path) => events.push(`start:${path}`),
				onPathComplete: (path) => events.push(`complete:${path}`),
			}),
		);
		act(() => {
			result.current.consume(patch("title", "Hello", "add"));
			result.current.consume({
				path: "title",
				value: undefined,
				op: "complete",
			});
		});
		expect(events.indexOf("start:title")).toBeLessThan(
			events.indexOf("complete:title"),
		);
	});

	it("resets seen paths on reset()", () => {
		const onPathStart = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onPathStart }),
		);
		act(() => {
			result.current.consume(patch("title", "Hello", "add"));
		});
		expect(onPathStart).toHaveBeenCalledOnce();

		act(() => result.current.reset());
		act(() => {
			result.current.consume(patch("title", "World", "add"));
		});
		expect(onPathStart).toHaveBeenCalledTimes(2);
	});

	it("pathstart value is a snapshot not a live reference", () => {
		const snapshots: unknown[] = [];
		const { result } = renderHook(() =>
			useJsonPulse<{ card: { term: string } }>({
				onPathStart: (path, value) => {
					if (path === "card") snapshots.push(value);
				},
			}),
		);
		act(() => {
			result.current.consume(patch("card", {}, "add"));
			result.current.consume(patch("card.term", "Mitosis", "add"));
		});
		// snapshot captured at pathstart should still be {} even after card.term was added
		expect(snapshots[0]).toEqual({});
	});
});

describe("useJsonPulse — pathcomplete", () => {
	it("calls onPathComplete when a primitive path is sealed", () => {
		const onPathComplete = vi.fn();
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({ onPathComplete }),
		);
		act(() => {
			result.current.consume(patch("title", "Hello", "add"));
			result.current.consume({ path: "title", value: "Hello", op: "complete" });
		});
		expect(onPathComplete).toHaveBeenCalledWith("title", "Hello");
	});

	it("calls onPathComplete for nested paths in order", () => {
		const calls: string[] = [];
		const { result } = renderHook(() =>
			useJsonPulse<{ cards: { term: string }[] }>({
				onPathComplete: (path) => calls.push(path),
			}),
		);
		act(() => {
			result.current.consume(patch("cards", [], "add"));
			result.current.consume(patch("cards[0]", {}, "add"));
			result.current.consume(patch("cards[0].term", "Mitosis", "add"));
			result.current.consume({
				path: "cards[0].term",
				value: "Mitosis",
				op: "complete",
			});
			result.current.consume({
				path: "cards[0]",
				value: { term: "Mitosis" },
				op: "complete",
			});
			result.current.consume({
				path: "cards",
				value: [{ term: "Mitosis" }],
				op: "complete",
			});
		});
		expect(calls.indexOf("cards[0].term")).toBeLessThan(
			calls.indexOf("cards[0]"),
		);
		expect(calls.indexOf("cards[0]")).toBeLessThan(calls.indexOf("cards"));
	});

	it("does not mutate data state on complete patches", () => {
		const { result } = renderHook(() => useJsonPulse<{ title: string }>());
		act(() => {
			result.current.consume(patch("title", "Hello", "add"));
		});
		const dataBefore = result.current.data;
		act(() => {
			result.current.consume({ path: "title", value: "Hello", op: "complete" });
		});
		// State should be identical — complete patches don't change data
		expect(result.current.data).toEqual(dataBefore);
		expect(result.current.data.title).toBe("Hello");
	});

	it("consumer can filter by path pattern", () => {
		const cardCompletions: unknown[] = [];
		const { result } = renderHook(() =>
			useJsonPulse<{ cards: { term: string }[] }>({
				onPathComplete: (path, value) => {
					if (/^cards\[\d+\]$/.test(path)) cardCompletions.push(value);
				},
			}),
		);
		act(() => {
			result.current.consume(patch("cards", [], "add"));
			result.current.consume(patch("cards[0]", {}, "add"));
			result.current.consume(patch("cards[0].term", "Mitosis", "add"));
			result.current.consume({
				path: "cards[0].term",
				value: "Mitosis",
				op: "complete",
			});
			result.current.consume({
				path: "cards[0]",
				value: { term: "Mitosis" },
				op: "complete",
			});
		});
		expect(cardCompletions).toHaveLength(1);
		expect(cardCompletions[0]).toMatchObject({ term: "Mitosis" });
	});

	it("complete patches pass through middleware", () => {
		const seen: string[] = [];
		const { result } = renderHook(() =>
			useJsonPulse<{ title: string }>({
				middleware: [
					(p, next) => {
						seen.push(`${p.op}:${p.path}`);
						next(p);
					},
				],
			}),
		);
		act(() => {
			result.current.consume(patch("title", "Hello", "add"));
			result.current.consume({
				path: "title",
				value: undefined,
				op: "complete",
			});
		});
		expect(seen).toContain("add:title");
		expect(seen).toContain("complete:title");
	});
});

// ---------------------------------------------------------------------------
// Reset and reuse
// ---------------------------------------------------------------------------

describe("useJsonPulse — reset and reuse", () => {
	it("can be reused after reset", () => {
		const { result } = renderHook(() => useJsonPulse<{ n: number }>());

		act(() => {
			result.current.consume(patch("n", 1));
			result.current.complete();
		});
		expect(result.current.data.n).toBe(1);
		expect(result.current.status).toBe("complete");

		act(() => result.current.reset());
		expect(result.current.data).toEqual({});
		expect(result.current.status).toBe("idle");

		act(() => {
			result.current.consume(patch("n", 2));
			result.current.complete();
		});
		expect(result.current.data.n).toBe(2);
		expect(result.current.status).toBe("complete");
	});

	it("complete() is idempotent", () => {
		const onComplete = vi.fn();
		const { result } = renderHook(() => useJsonPulse({ onComplete }));
		act(() => {
			result.current.consume(patch("x", 1));
			result.current.complete();
			result.current.complete(); // second call — should not double-fire
		});
		expect(onComplete).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Realistic streaming simulation
// ---------------------------------------------------------------------------

describe("useJsonPulse — streaming simulation", () => {
	it("assembles a flashcard set from a realistic patch sequence", () => {
		const { result } = renderHook(() =>
			useJsonPulse<{
				title: string;
				cards: { term: string; definition: { text: string } }[];
			}>(),
		);

		const patches: StreamingChunk[] = [
			{ path: "title", value: "", op: "add" },
			{ path: "title", value: "Cell Bio", op: "append" },
			{ path: "cards", value: [], op: "add" },
			{ path: "cards[0]", value: {}, op: "add" },
			{ path: "cards[0].term", value: "Mit", op: "add" },
			{ path: "cards[0].term", value: "osis", op: "append" },
			{ path: "cards[0].definition", value: {}, op: "add" },
			{ path: "cards[0].definition.text", value: "Cell ", op: "add" },
			{ path: "cards[0].definition.text", value: "division", op: "append" },
			{ path: "cards[1]", value: {}, op: "add" },
			{ path: "cards[1].term", value: "Meiosis", op: "add" },
		];

		act(() => {
			for (const p of patches) result.current.consume(p);
			result.current.complete();
		});

		expect(result.current.data).toMatchObject({
			title: "Cell Bio",
			cards: [
				{ term: "Mitosis", definition: { text: "Cell division" } },
				{ term: "Meiosis" },
			],
		});
		expect(result.current.status).toBe("complete");
	});
});

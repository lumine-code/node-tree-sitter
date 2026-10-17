# Ownership and re-entry review

Reviewed on 2026-10-17 against baseline `d66cb6f9a00e94f2627dd683e324cd766665b877`. The implementation is `0edfc4888c1b963d07e0d13762ec4505388eca65`. Changes are restricted to the maintained binding, regression tests, benchmark controls and documentation. The upstream runtime remains unmodified at `10eb5ac119eec9cb4267a8e035066473983f5f3a`; editor core, display layer, grammars and dependency pins are unchanged.

## Confirmed defects

- **Logger ownership cycle**: a native strong reference retained the logger callback. If its closure referenced the parser, neither object could become unreachable from the collector's perspective. A baseline probe retained both objects after thirty forced collections. Each parser now retains its callback through a private WeakMap ownership edge visible to V8; the native callback reference is weak. Tests verify collection of twenty parser/callback cycles, retention while the parser is live, and release after replacement or disabling.
- **Cursor ownership cycle**: a native strong reference from cursor to tree prevented collection when the tree stored that cursor. Cursor ownership now uses the same GC-visible relation. Tests cover cycles created through `walk()`, `reset()` and `resetTo()`, while preserving live-cursor retention and release of previous owners.
- **Wrong native tree after reset**: the earlier ownership refactor updated the cursor's JavaScript-visible owner but still reconstructed the native node using the previous tree. `reset()` now uses its target tree consistently. Earlier same-language tests checked owner identity and text but did not expose the native mismatch. New tests reset between JavaScript, Python, JSON and HTML, compare native cursor/node types and traversal with fresh cursors, and exercise collection of the previous tree.
- **Mutation through search arguments**: point and type-list getters could edit a tree after a native node had been reconstructed for a search. The affected node searches hold a read guard during argument evaluation. Cursor point searches also recheck their edit generation after evaluating getters, preventing traversal with a cursor invalidated during that evaluation. Exceptions release guards and ordinary later searches still work.

These changes do not turn native references weak without preserving ownership: a live parser still keeps its logger alive, and a live cursor still keeps its tree alive. The difference is that the collector can now trace the ownership edges and collect otherwise unreachable cycles.

## Query comparison and upstream observations

The differential suite adds 1,152 result comparisons against web-tree-sitter 0.27.1: twelve predicates, four inputs including empty and repeated captures, three stages of capture/pattern disabling, four search configurations and both `matches()` and `captures()`. Existing tests continue to cover native UTF-16 numeric ranges and callback exceptions. The upstream open-issue list was checked again, including [receiver safety (#290)](https://github.com/tree-sitter/node-tree-sitter/issues/290), [callback retention (#287)](https://github.com/tree-sitter/node-tree-sitter/issues/287) and [predicate semantics (#98)](https://github.com/tree-sitter/node-tree-sitter/issues/98).

Two observed reference behaviors must not be mistaken for binding regressions. In web-tree-sitter 0.27.1, numeric query bounds are passed to the byte-range API without the conversion used for point columns: querying indices 6 through 8 in `a; b; c;` returns `b`, whereas this package's UTF-16 contract returns `c`. Differential bounded searches therefore use equivalent point bounds; native numeric-range tests retain their explicit expected result. The [web binding source](https://github.com/tree-sitter/tree-sitter/blob/10eb5ac119eec9cb4267a8e035066473983f5f3a/lib/binding_web/lib/tree-sitter.c) also reuses a scratch query cursor. Its existing capture pool can exceed a newly reduced match limit because the [upstream pool implementation](https://github.com/tree-sitter/tree-sitter/blob/10eb5ac119eec9cb4267a8e035066473983f5f3a/lib/src/query.c) reuses free entries before applying the allocation limit. Differential tests use a non-exhausting limit; a separate native test verifies that limit 1 produces the same partial result and exceeded-limit flag before and after an unlimited execution. This package retains a fresh cursor per query execution. No upstream source was patched to change either behavior.

## Performance controls

The [mixed-workload results](../benchmark/results/2026-10-17-ownership-controls-windows-x64.json) use four processes per variant in A-B-B-A-A-B-B-A order, two warmups and seven samples per workload. Values are medians of process medians in milliseconds; output checksums agree.

| Workload | Baseline | Updated |
| --- | ---: | ---: |
| Submit 5,000 ascending edits | 14.773 | 15.250 |
| Submit 5,000 descending edits | 14.321 | 14.573 |
| Quantified predicate captures | 105.795 | 104.840 |
| Same predicate on a background snapshot | 105.125 | 104.764 |
| Simple 20,000-capture query | 61.971 | 58.800 |
| Full cursor traversal | 272.206 | 317.848 |

The mixed run showed a 16.8% cursor slowdown, so traversal was measured separately with fifteen samples per process and the same eight-process order. That [isolated timing run](../benchmark/results/2026-10-17-ownership-cursor-windows-x64.json) produced medians of 328.765 ms for the baseline and 307.047 ms for the candidate. Individual process medians ranged from 280.257 to 345.164 ms for the baseline and 287.876 to 348.533 ms for the candidate. Both runs are retained: the large variation does not establish a repeatable slowdown or a speedup. The machine was not isolated from other workloads, and these are not editor latency measurements. No speculative traversal optimization was added on the strength of either median.

Repeat all controls with `node benchmark/predicates.js <baseline-directory>`. Set `BENCH_CASE=cursorWalk` and `BENCH_SAMPLES=15` to time only cursor traversal while still executing correctness checks for the other workloads. Other workload names in the table's raw result file can also be selected with `BENCH_CASE`.

## Validation

The complete local suite passed all 176 tests. Forced-GC ownership tests, cross-language cursor reset tests, differential queries, existing worker termination checks and exception recovery passed. Lint, TypeScript checks and Electron 44.9 renderer/reload checks passed; npm audit reported zero vulnerabilities. The existing integration limitations in the [pre-integration review](pre-integration-review.md#integration-decisions-still-required) remain: input copies, shared libuv scheduling, synchronous queries and host-owned language layers. This review adds no editor integration or new public feature surface.

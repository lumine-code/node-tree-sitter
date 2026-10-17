# Predicate and node identity review

Reviewed on 2026-10-17. The baseline is `668d0e32f783540d115342b8cac057b8e1ac091f`; the measured implementation is `4110de602bd1f7baa287ee33c166a37a5e3a4193`. This round changes the Node.js bindings, JavaScript helpers and tests only. The Tree-sitter vendor sources and submodule revision remain unchanged, as do Lumine core, display layer, grammar packages and dependency pins.

## Corrected findings

- **Offset node identity**: the cache keyed wrappers only by native node ID, so `rootNodeWithOffset()` could return an already cached unshifted node. Trees using offset views now distinguish all four native context words, retain each view independently and update cached contexts on edits. Ordinary trees keep the compact ID cache. Scalar node reads also avoid constructing unnecessary BigInt batch keys.
- **Foreign-language trees**: synchronous parsing, queries and changed-range comparisons reject trees from another language before invoking the corresponding native operation. Background parsing already enforced this boundary.
- **Generated class source**: specialized node classes interpolated grammar names into JavaScript source. Class names are now assigned as data. This concerns the supported descriptor path with `nodeTypeInfo`; the default Wasm loader uses generic nodes and did not enter that generator. A regression uses a synthetic grammar symbol and verifies that it does not execute JavaScript.
- **Repeated predicate materialization**: consecutive captures reuse a predicate context only after comparing the complete match identity, capture indices, node IDs and positional contexts. Predicate acceptance is reused only for immutable snapshots or ordinary string-backed trees. Callback input, custom text readers and accessors remain observable on each emission. Returned capture objects remain independent.
- **Large ordered edit batches**: ascending and descending non-overlapping sequential edits share one coordinate scan and one final text join. Dependent or overlapping batches retain the piece-array fallback. Tests compare 5,000-edit results with fresh parses and cover changing lengths and newlines.

## Measurements

The [raw results](../benchmark/results/2026-10-17-predicates-windows-x64.json) record four fresh processes per variant in A-B-B-A-A-B-B-A order, two warmups and seven samples per workload, binary hashes and matching output checksums. Values below are medians of process medians in milliseconds. These are local Windows x64 binding measurements on a machine not isolated from other work, not editor latency measurements or performance guarantees.

| Workload | Baseline | Updated |
| --- | ---: | ---: |
| Submit 5,000 ascending edits | 399.326 | 15.680 |
| Submit 5,000 descending edits | 33.342 | 14.790 |
| Quantified captures with a text predicate | 432.023 | 104.553 |
| Same predicate on a background snapshot | 443.135 | 104.895 |
| Simple 20,000-capture query | 79.671 | 79.538 |
| Full cursor traversal | 420.693 | 438.285 |

Ascending edit submission improved approximately 25 times, descending submission 2.3 times and the quantified predicate workload 4.1 times. Ordinary queries were essentially unchanged. Cursor traversal was 4.2% slower and remains a regression to monitor in integration measurements; this review does not claim an across-the-board speedup. Submission measures preparation on the caller, not completed parsing. Predicate input contains 512 numbers; cursor and ordinary-query controls use 20,000 declaration lines.

To reproduce, preserve the baseline JavaScript files and its built addon in a separate directory with access to the same dependencies, then run `node benchmark/predicates.js <baseline-directory>`. Exact context comparisons can still be quadratic for large quantified matches, and changing contexts still require materialization. Arbitrary dependent edit batches can also remain quadratic. These optimizations remove repeated work in the measured cases without imposing general latency bounds.

## Issues and remaining scope

The upstream review revisited [receiver confusion (#290)](https://github.com/tree-sitter/node-tree-sitter/issues/290), [retained callbacks (#287)](https://github.com/tree-sitter/node-tree-sitter/issues/287) and [quantified predicate semantics (#98)](https://github.com/tree-sitter/node-tree-sitter/issues/98). Existing guards and lifetime tests remain; predicate differential tests use web-tree-sitter 0.27.1 as the current compatibility reference. [Query iterators (#178)](https://github.com/tree-sitter/node-tree-sitter/issues/178) and [additional directives/custom predicates (#179)](https://github.com/tree-sitter/node-tree-sitter/issues/179) remain capability gaps: queries materialize arrays and unsupported directives reject explicitly.

The [earlier integration review](pre-integration-review.md#integration-decisions-still-required) still applies: full native input copies, shared libuv workers, synchronous queries, missing query introspection and host-owned injection orchestration remain. No native runtime fork is introduced by this work.

## Validation

The final local suite passed all 158 tests, including forced-GC lifecycle checks and differential predicate tests. Lint, TypeScript checks, Electron 44.9 renderer/reload checks and package contents validation passed; npm audit reported zero vulnerabilities. The first full run passed 157 tests and failed the existing timeout assertion requiring completion within 2 ms. That test passed in the isolated parser suite, and the complete rerun passed without changing the timeout or test implementation.

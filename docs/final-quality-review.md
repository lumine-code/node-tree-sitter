# Final standalone quality review

Reviewed on 2026-10-17 against baseline `cc2df86902f92ededfba66f6763d60338550a109`. The measured implementation is `e59db5828c77cf0cfddd1eac43ec918ca4a89c42`. All changes are in the maintained Node.js binding, its JavaScript API, tests and documentation. The Tree-sitter submodule remains unmodified at `10eb5ac119eec9cb4267a8e035066473983f5f3a`; Lumine core, display layer, language packages and dependency pins were not changed.

## Findings resolved

- **Native cursor leak**: `childrenForFieldName()` and `childrenForFieldId()` created a cursor without deleting its storage. Both now share an environment-owned scratch cursor, with no per-call cursor allocation. Repeated field lookups retain node identities, include every repeated field and return empty results for absent fields and leaf nodes.
- **Background submission re-entry**: reading options and range getters could start another parse, cancel a request or close the native parser before submission finished. JavaScript reserves the request before option reads and normalizes range properties once. The native boundary independently reserves its parser and defers resource release while arguments are read. Validation and queueing failures release the reservation. Close/cancel/re-entry/throw scenarios have direct native and public API regression coverage.
- **Snapshot consistency**: editable copies of background snapshots retained a text reader closed over the original snapshot. Copies now read their own `input`. Background incremental parsing requires a genuine immutable snapshot rather than accepting a mutable tree with potentially inconsistent text. Another background parser can reuse a snapshot with the same language descriptor. Fresh native grammar descriptors now initialize their node classes when used directly with a background parser.
- **Query argument evaluation**: point getters could overwrite the shared node transfer buffer by reading another node before query execution. All query point coordinates and predicate flags are now evaluated before transferring the queried node.
- **Query string truncation**: predicate strings ignored their native length and stopped at embedded NUL. For example, a predicate for `a` followed by NUL and `b` incorrectly matched `a`. Strings now preserve their full length. Directive keys such as `__proto__` are defined as own data properties, so they neither disappear nor change the property's object prototype.
- **Error and numeric boundaries**: child indices, public field IDs and query step offsets reject truncating conversions. Synchronous parsing rejects primitive previous-tree arguments and nonnumeric buffer sizes. A throwing logger error handler no longer lets an exception escape through the native logging callback; the parse reports it and the parser can be reused.
- **TypeScript contract**: document offsets are documented as UTF-16 code units; query-source offsets remain UTF-8 bytes. Declarations now reflect fluent parser methods, nullable language/logger values, cursor search indices, absent field metadata, mutable tree input, optional edit ranges, query property metadata and snapshot requirements. Compile-time regression checks exercise both valid uses and rejected uses. Runtime return values were preserved.

## Memory and performance

The [field lookup measurements](../benchmark/results/2026-10-17-final-fields-windows-x64.json) use four fresh processes per variant in A-B-B-A-A-B-B-A order. Each process warms up with 20,000 lookups, then runs five measured batches of 80,000 lookups, split equally between field names and field IDs. All result identities and checksums agree. RSS is sampled after explicit garbage collection; it includes allocator and runtime behavior and is not a direct byte count of live native allocations.

| Field lookup metric | Baseline | Updated |
| --- | ---: | ---: |
| Median time per 80,000 lookups | 155.899 ms | 146.044 ms |
| Median RSS growth over 400,000 lookups | 107.53 MiB | 0.18 MiB |

Baseline RSS grew with every measured batch in all four processes, while the updated process remained approximately flat. Together with removal of the unmatched cursor allocation, this verifies the specific leak fix. It does not assert zero memory growth for every workload.

The [control measurements](../benchmark/results/2026-10-17-final-controls-windows-x64.json) repeat the previous round's workloads with four processes per variant, two warmups and seven samples per process. The table reports medians of process medians in milliseconds.

| Workload | Baseline | Updated |
| --- | ---: | ---: |
| Submit 5,000 ascending edits | 14.771 | 14.734 |
| Submit 5,000 descending edits | 14.665 | 14.138 |
| Quantified predicate captures | 103.729 | 103.958 |
| Same predicate on a background snapshot | 102.847 | 102.821 |
| Simple 20,000-capture query | 60.868 | 60.914 |
| Full cursor traversal | 336.823 | 311.808 |

Ordinary queries and predicate workloads remained essentially unchanged; no regression was observed in these controls. Cursor traversal was faster in this run, but this round does not claim a targeted cursor traversal optimization or a statistically established improvement. The machine was not isolated from other work. Submission time is not total parsing time, and none of these measurements represents editor frame latency. Reproduce with `node benchmark/fields.js <baseline-directory>` and `node benchmark/predicates.js <baseline-directory>`; result files retain samples, memory readings and binary hashes.

## Validation and integration boundary

The complete local suite passed all 168 tests. This includes 400 deterministic batches containing 3,200 mixed edits, fresh-parse comparisons for 80 batches, embedded NUL/Unicode/CRLF inputs, direct native re-entry checks, field traversal repetition and existing cancellation, forced-GC and worker teardown tests. Lint covers the JavaScript entry point as well as helpers and review tests. TypeScript checks, Electron 44.9 renderer/reload checks and package contents checks passed. npm audit reported zero vulnerabilities. Package output retains both license files and the regression tests.

The upstream open-issue list was checked again, including [native receiver safety (#290)](https://github.com/tree-sitter/node-tree-sitter/issues/290), [callback retention (#287)](https://github.com/tree-sitter/node-tree-sitter/issues/287), [predicate semantics (#98)](https://github.com/tree-sitter/node-tree-sitter/issues/98), [additional directives (#179)](https://github.com/tree-sitter/node-tree-sitter/issues/179) and [query iterators (#178)](https://github.com/tree-sitter/node-tree-sitter/issues/178). This review does not claim to close those upstream issues or add streaming query iterators and every directive.

The standalone package is prepared for an isolated integration prototype. The [existing integration boundaries](pre-integration-review.md#integration-decisions-still-required) still apply: full text copies, a shared libuv pool, synchronous queries, host-owned injections and missing query introspection. Ordered edits and repeated predicate contexts have fast paths, but arbitrary dependent edits and quantified context comparisons can still have quadratic costs. Background snapshots, languages and queries cannot be transferred as live native objects between Node workers. Broader grammar-fleet and editor-latency validation belongs to integration, without modifying the upstream runtime to accommodate this binding.

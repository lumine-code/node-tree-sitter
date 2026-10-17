# Pre-integration review

Reviewed on 2026-10-17 against the standalone binding, without modifying Lumine core, Superstring, grammar packages or dependency pins. The baseline is `c53aadc0ceaf99d60aa2656af6d94df41b08d1a6`; the implementation reviewed after fixes is `17713380f6e086b519b14a95447871d80bbfba8f`.

## Corrected findings

- **Main-thread parser setup**: background parser constructors initialized Wasmtime stores and instantiated their language synchronously. Store initialization now runs in the first background job. This moves work off the caller; it does not remove its CPU cost or make first-use completion instantaneous.
- **Repeated document reconstruction**: sequential edit preparation rebuilt the full text and scanned its prefix multiple times per edit. Batches now use temporary pieces and newline indexes, materializing the final text once. Single edits have a direct forward-scan path. Arbitrarily large batches still need a real native buffer interface; the temporary piece array has linear traversal per edit.
- **Repeated range scans**: each included-range endpoint restarted its line scan at the beginning of the document. Ordered ranges now share a forward coordinate scan.
- **Quadratic capture marshaling**: native capture iteration sent every capture in the match back to JavaScript for each emitted capture, even when no text predicate needed the context. Such patterns now transfer only the emitted capture. Text-predicate patterns retain their full context, with differential tests against web-tree-sitter covering order, duplicates and properties.
- **Invalid pattern-index assertion**: several query methods forwarded arbitrary indices to native array access. Negative, fractional, non-finite and out-of-bounds indices now throw before entering Tree-sitter. A baseline regression probe exposed this as a Windows CRT assertion dialog; automated tests now opt into stderr-only CRT reporting so a future native assertion fails the process rather than opening a modal window.
- **Mutation during native reads**: a synchronous input or query progress callback could edit the tree currently being traversed. Tree read guards now reject such edits and release the guard on exceptions, allowing subsequent normal edits.

## Measurements

The [raw results](../benchmark/results/2026-10-17-review-windows-x64.json) contain four fresh processes per variant, run in A-B-B-A-A-B-B-A order, two warmups and seven measured samples per workload. The table reports the median of process medians, in milliseconds. Inputs and output checksums are identical between variants. The parser corpus is 20,000 JavaScript lines; quantified-query input contains 512 numbers. These are local binding measurements, not editor rendering results or statistical guarantees across hardware.

| Workload | Baseline | Updated |
| --- | ---: | ---: |
| Construct and close 32 background parsers | 64.945 | 0.101 |
| Submit 128 edits | 85.333 | 2.127 |
| Submit 512 included ranges | 10.376 | 0.805 |
| Submit one edit at document end | 0.804 | 0.448 |
| Quantified captures without text predicates | 139.528 | 4.465 |
| Same captures with a text predicate | 340.788 | 297.597 |
| Simple 20,000-capture query | 58.989 | 61.399 |

The simple-query result did not improve and was 4.1% slower in the mixed-workload run. A separate eight-process A-B-B-A-A-B-B-A probe of that workload alone, with twenty measured samples per process, produced process medians of 48.48/49.13/49.76/48.84 ms for the baseline and 49.78/49.24/52.40/49.21 ms for the candidate. Their ranges overlap; no simple-query speedup is claimed. Text-predicate capture marshaling was not optimized by this change, so its timing difference should not be generalized into a performance promise.

To repeat the comparison, preserve the baseline package's JavaScript files and its built addon in a separate directory whose dependency lookup resolves the same dependencies, then run `node benchmark/review.js <baseline-directory>`. The output records binary SHA-256 values. The script performs only valid operations against the old binary; invalid-index regression tests belong to the updated build. Run on an idle machine and repeat when checking an integration threshold.

## Upstream issues checked

- [#287: retained progress callbacks](https://github.com/tree-sitter/node-tree-sitter/issues/287): the earlier RAII fix is retained. A forced-GC regression test now verifies that forty callbacks used by both parsing and queries become collectable.
- [#290: native receiver confusion](https://github.com/tree-sitter/node-tree-sitter/issues/290): the existing receiver checks and cursor type tag remain in place. Invalid receiver probes throw TypeError; malformed pattern indices were an additional independent defect fixed during this review.
- [#98: predicates on alternating and repeating patterns](https://github.com/tree-sitter/node-tree-sitter/issues/98): the historical expectation is not a suitable current oracle. The current fork is compared to web-tree-sitter 0.27.1 for quantified captures with positive and negative outcomes. This review does not claim to implement a different predicate language.
- [#179: additional directives/custom predicates](https://github.com/tree-sitter/node-tree-sitter/issues/179) and [#178: query iterators](https://github.com/tree-sitter/node-tree-sitter/issues/178): these remain capability gaps. Unsupported predicates reject instead of silently changing meaning, and the public query API still materializes arrays.

## Integration decisions still required

The binding is ready for an isolated integration prototype, not a drop-in replacement for Lumine's complete language mode. Full text strings are still copied into native memory on each request. A future host must supply or agree a native text-snapshot interface and measure submission costs on large documents.

Parsing and Wasm compilation share Node's libuv worker pool with other work. A host must bound requests, prioritize the active buffer and account for filesystem/DNS contention, or implement a dedicated execution pool. The library currently rejects concurrent requests on one parser rather than coalescing revisions.

Queries and predicate evaluation remain synchronous. The capture optimization removes avoidable data expansion but does not bound traversal time or result size. Whole-document highlighting, symbols and injection discovery must not be routed through an unbounded renderer-side query loop. Cancellation is cooperative and cannot immediately interrupt an arbitrary long-running external scanner.

The injection graph, grammar reload generations, atomic publication of all language layers and Lumine's custom scope semantics remain host responsibilities. Query introspection also differs from web-tree-sitter: its `captureNames`, `captureQuantifiers`, `patternCount()` and general-predicate introspection are not yet exposed by this fork. The new core contract must account for the metadata needed to validate injection rules before replacing the current implementation.

The four committed Wasm fixtures cover JavaScript, Python, HTML and JSON. They are useful compatibility checks, but validation of every grammar and query in the fleet still belongs to the eventual integration. No editor-level performance or memory improvement is asserted by these standalone results.

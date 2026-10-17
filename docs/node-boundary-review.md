# Node boundaries and query allocation review

Reviewed on 2026-10-18 against baseline `785b37b420e886f2d2a1273602c56f761c6f5979`. The implementation is `cafa4630a15428c7d4fd1b7bba6c8ae745f835aa`. Tree-sitter vendor sources and the submodule revision are unchanged, as are editor core, display layer, language packages and dependency pins.

## Corrections and allocation changes

- **Query initialization leak**: native query compilation can succeed before JavaScript predicate initialization rejects an unsupported predicate or invalid regular expression. A throwing C++ constructor does not run the class destructor, so the native query previously leaked. A scoped native owner now releases it on initialization failure and transfers ownership only after successful construction. Query source sizes are also checked before conversion to the native 32-bit length.
- **Node provenance**: marshalling previously checked only whether an object's `tree` looked like a Tree. SyntaxNode construction now requires a private token, and native-bound operations check a private class brand before accessing node fields. Clones, prototype imitations and proxies are rejected. A regression test verifies that a fabricated receiver's `tree` getter is not evaluated, and subsequent valid queries and cursor resets still work.
- **Internal cache API**: cache registration functions are captured inside the module and removed from the public Tree prototype. The unused raw transfer-offset registration path was removed. Nodes created through normal traversal and queries retain their existing identities.
- **Capture names**: each native query execution creates a JavaScript string once per used capture name, rather than once per returned capture. Reuse is local to the execution and preserves explicit string lengths.
- **Batch identity keys**: node deduplication indexes the high and low unsigned 32-bit words separately instead of allocating a BigInt key per transferred node. Both words remain exact; positional contexts are still compared. Tests cover repeated captures sharing one node, distinct result objects and per-pattern metadata across 12,000 captures.

The private field used for provenance avoids registering every node in a separate WeakSet. An experimental WeakSet implementation showed a substantial traversal cost and was replaced before the final measurements below. No public query features or editor integration were added.

## Constructor failure memory

The [query error measurements](../benchmark/results/2026-10-18-query-errors-windows-x64.json) run four fresh processes per variant in A-B-B-A-A-B-B-A order. Each process warms up with 100 failures, then executes five batches of 1,000 failures, alternating unsupported predicates and invalid regular expressions. Exception kinds are checked. Memory is sampled after explicit GC.

| Metric | Baseline | Updated |
| --- | ---: | ---: |
| Median time per 1,000 failed constructions | 704.475 ms | 705.430 ms |
| Median RSS growth over 5,000 failures | 6.27 MiB | 0.57 MiB |

The baseline grew steadily across batches in all four processes; the candidate remained approximately flat after its initial allocation changes. RSS includes the JavaScript runtime and allocator behavior, so this is not a direct count of leaked native bytes. The code correction removes the specific unowned native-query path; no constructor speedup is claimed.

## Capture and traversal measurements

The [cold capture benchmark](../benchmark/results/2026-10-18-cold-captures-windows-x64.json) queries 20,000 identifiers with two capture names each. It drops the previous result, yields to another turn and forces GC before each sample so wrapper construction and deduplication are measured. It checks that repeated captures share a node while retaining distinct capture objects. Four processes per variant each use two warmups and fifteen measured samples.

| Workload | Baseline | Updated |
| --- | ---: | ---: |
| 40,000 captures with fresh node wrappers | 97.636 ms | 93.609 ms |

This run showed about 4.1% lower latency for fresh wrappers. The [mixed control run](../benchmark/results/2026-10-18-node-boundary-controls-windows-x64.json) uses the same eight-process order, two warmups and seven samples per workload. Its repeated simple-query workload retains the previous result and therefore exercises cached wrappers. Values are medians of process medians in milliseconds.

| Workload | Baseline | Updated |
| --- | ---: | ---: |
| Submit 5,000 ascending edits | 15.374 | 14.943 |
| Submit 5,000 descending edits | 14.657 | 14.506 |
| Quantified predicate captures | 104.786 | 101.970 |
| Same predicate on a background snapshot | 103.224 | 101.915 |
| Simple 20,000-capture query with cached wrappers | 71.281 | 74.050 |
| Full cursor traversal | 407.464 | 411.979 |

Cached-wrapper queries were 3.9% slower and traversal 1.1% slower in this run. Both costs are reported; no universal speedup is claimed. Per-process cached-query medians ranged from 64.845 to 82.197 ms in the baseline and 62.435 to 80.033 ms in the candidate. The machine was not isolated from other work, and these measurements are not editor latency or statistical guarantees. The edit paths were not optimized by this change.

Reproduce with `node benchmark/query-errors.js <baseline-directory>`, `node benchmark/cold-captures.js <baseline-directory>` and `node benchmark/predicates.js <baseline-directory>`. Raw results include process samples, runtime versions and binary hashes.

## Validation

The final local suite passed all 179 tests, including 1,000 rejected predicate constructions, failed constructor recovery, fabricated-node rejection, large capture identity checks, GC ownership and the existing differential query suite. Lint, TypeScript checks and Electron 44.9 renderer/reload checks passed; npm audit reported zero vulnerabilities. The [existing integration boundary](pre-integration-review.md#integration-decisions-still-required) remains unchanged: full input copies, shared worker-pool scheduling, synchronous queries and host-owned language layers still require integration work.

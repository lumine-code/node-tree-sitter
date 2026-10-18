# node-tree-sitter

Provides native Tree-sitter bindings with portable Wasm grammars.

Fork of [tree-sitter/node-tree-sitter](https://github.com/tree-sitter/node-tree-sitter).

> [!WARNING]
> **This package is deprecated.** [Lumine](https://github.com/lumine-code/lumine) now uses [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) for its portable grammar runtime. This native runtime experiment is retained for reference. This repository is archived and no longer maintained.

Consumed through immutable GitHub commit pins. This package is not published to npm.

## Features

- **Portable grammars**: loads Tree-sitter `.wasm` language modules through Wasmtime while keeping syntax trees native.
- **Background parsing**: compiles grammars and parses owned text snapshots outside the JavaScript event loop.
- **Immutable snapshots**: retains each result's original text, coordinates and caller-supplied revision during subsequent incremental parses.
- **Cancellation**: supports AbortSignal, explicit cancellation and parser closure.
- **Syntax queries**: exposes native nodes, cursors and synchronous Tree-sitter queries through Node-API.
- **Validation**: compares unchanged Wasm fixtures against web-tree-sitter and checks incremental edits, Unicode, cancellation and worker teardown.

## Building

Requires Node.js 24.18 or newer, a C/C++ toolchain supported by node-gyp, Python and `tar`. The native Tree-sitter runtime is pinned to 0.27.1. The editor and its dependencies do not need to be changed to build or test this repository.

```sh
git clone --recurse-submodules https://github.com/lumine-code/node-tree-sitter.git
cd node-tree-sitter
npm ci --ignore-scripts
npm run setup:wasmtime
npm run rebuild
npm test
```

The explicit setup command downloads a pinned Wasmtime 48.0.1 C API archive and verifies its SHA-256 before extraction. It supports Windows, macOS and glibc Linux on x64 and ARM64. Alternatively, set `WASMTIME_ROOT` to a compatible C API distribution or source build containing `include/` and `lib/`. No download runs from the package install hook. Wasmtime is linked statically into the addon; language packages remain platform-independent Wasm files. This repository contains no Rust implementation, although Wasmtime itself is built from Rust.

Source installation from an npm or Git package also requires a prepared `WASMTIME_ROOT` when no matching prebuild is available. Git dependency archives omit submodules; run `npm run setup:runtime` in the installed package before building when `vendor/tree-sitter/lib/src/lib.c` is absent. This explicit command downloads the pinned upstream source archive, verifies its SHA-256 and extracts the unmodified C runtime and headers. A recursive checkout or source tarball already containing those files needs no download. Neither provisioning command runs from an install hook. This initial fork does not publish prebuilds or releases automatically on branch pushes.

## Usage

```js
const fs = require('node:fs/promises');
const {loadLanguage, BackgroundParser, Query} = require('@lumine-code/node-tree-sitter');

const language = await loadLanguage('javascript', await fs.readFile('javascript.wasm'));
const parser = new BackgroundParser(language);
try {
  const before = await parser.parse('const x = 1;', {revision: 1});
  const after = parser.parseSync('const name = 1;', {
    previous: before,
    edits: [{startIndex: 6, oldEndIndex: 7, newText: 'name'}],
    revision: 2,
  });
  console.log(before.rootNode.text); // const x = 1;
  console.log(after.rootNode.text); // const name = 1;
  const query = new Query(language, '(identifier) @name');
  console.log(query.captures(after.rootNode).map(capture => capture.node.text));
} finally {
  parser.close();
}
```

The language name is the grammar export name, such as `javascript` or `python`, rather than the Wasm filename. Parser offsets and columns use UTF-16 code units. See [the background parsing contract](docs/background-parsing.md) for ownership, cancellation and limits.

## Benchmarks

```sh
npm run benchmark
```

The benchmark runs web-tree-sitter, synchronous native parsing and background native parsing in separate Node processes against the same JavaScript Wasm fixture. It reports cold initialization, initial and incremental parse duration, synchronous submission time, timer gaps, memory and a syntax-tree checksum. `BENCH_LINES` and `BENCH_SAMPLES` control workload size. See [benchmark methodology](docs/benchmarks.md). These results measure the standalone binding, not editor rendering or display-layer performance.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!

#ifndef NODE_TREE_SITTER_WASM_H_
#define NODE_TREE_SITTER_WASM_H_
#include <napi.h>
#include <memory>
#include <wasm.h>
#include "tree_sitter/api.h"
namespace node_tree_sitter {
using WasmEngine = std::shared_ptr<wasm_engine_t>;
WasmEngine GetWasmEngine(Napi::Env env);
TSWasmStore *NewWasmStore(const WasmEngine &engine);
void InitWasm(Napi::Env env, Napi::Object exports);
}
#endif

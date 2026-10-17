#include "tree_sitter/api.h"

#include <napi.h>
#include "./wasm.h"

#ifndef NODE_TREE_SITTER_ADDON_DATA_H_
#define NODE_TREE_SITTER_ADDON_DATA_H_

namespace node_tree_sitter {

class AddonData final {
public:
  explicit AddonData(Napi::Env env) {
    auto map = env.Global().Get("WeakMap").As<Napi::Function>().New({});
    ownership = Napi::Persistent(map);
    ownership_set = Napi::Persistent(map.Get("set").As<Napi::Function>());
  }

  // Trace each wrapper's one adopted dependency through V8, so a dependency
  // referring back to its owner does not form a permanent native root cycle.
  void RetainDependency(Napi::Object owner, Napi::Value dependency) {
    ownership_set.Call(ownership.Value(), {owner, dependency});
  }

  ~AddonData() {
    ts_tree_cursor_delete(&scratch_cursor);
  }

  // conversions
  uint32_t *point_transfer_buffer = nullptr;

  // node
  uint32_t *transfer_buffer = nullptr;
  uint32_t transfer_buffer_length = 0;
  Napi::ObjectReference module_exports;
  TSTreeCursor scratch_cursor = {nullptr, nullptr, {0, 0}};

  // parser
  Napi::FunctionReference parser_constructor;
  WasmEngine wasm_engine;
  Napi::FunctionReference string_slice;

  // query
  Napi::FunctionReference query_constructor;

  // tree_cursor
  Napi::FunctionReference tree_cursor_constructor;

  // tree
  Napi::FunctionReference tree_constructor;
  bool constructing_tree = false;
  bool constructing_cursor = false;

  // lookaheaditerator
  Napi::FunctionReference lookahead_iterator_constructor;

private:
  Napi::ObjectReference ownership;
  Napi::FunctionReference ownership_set;
};

} // namespace node_tree_sitter

#endif // NODE_TREE_SITTER_ADDON_DATA_H_

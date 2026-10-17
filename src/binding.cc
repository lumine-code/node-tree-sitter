#include "./addon_data.h"
#include "./conversions.h"
#include "./language.h"
#include "./lookaheaditerator.h"
#include "./node.h"
#include "./parser.h"
#include "./query.h"
#include "./tree.h"
#include "./tree_cursor.h"
#include "./wasm.h"

#include <napi.h>
#include <cstdlib>

using namespace Napi;

namespace node_tree_sitter {

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
#ifdef _WIN32
  // Automated regression probes must fail in stderr, never open a modal CRT
  // dialog. Normal application hosts keep their own error-reporting policy.
  if (std::getenv("NODE_TREE_SITTER_TEST_STDERR")) {
    _set_error_mode(_OUT_TO_STDERR);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
  }
#endif
  auto* data = new AddonData(env);
  env.SetInstanceData(data);

  InitConversions(env, exports);
  node_methods::Init(env, exports);
  language_methods::Init(env, exports);
  LookaheadIterator::Init(env, exports);
  Parser::Init(env, exports);
  Query::Init(env, exports);
  Tree::Init(env, exports);
  TreeCursor::Init(env, exports);
  InitWasm(env, exports);

  return exports;
}

NODE_API_MODULE(tree_sitter_runtime_binding, InitAll)

} // namespace node_tree_sitter

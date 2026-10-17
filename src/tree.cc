#include "./tree.h"
#include "./addon_data.h"
#include "./conversions.h"
#include "./node.h"
#include "./operation.h"

#include <napi.h>

using namespace Napi;

namespace node_tree_sitter {

/*
  tstag() {
    b2sum -l64 <(printf tree-sitter) <(printf "$1") | \
    awk '{printf "0x" toupper($1) (NR == 1 ? ", " : "\n")}'
  }
  tstag tree # => 0x8AF2E5212AD58ABF, 0x7FA28BFC1966AC2D
*/
const napi_type_tag TREE_TYPE_TAG = {
  0x8AF2E5212AD58ABF, 0x7FA28BFC1966AC2D
};

using node_methods::UnmarshalNodeId;

void Tree::Init(Napi::Env env, Napi::Object exports) {
  auto *data = env.GetInstanceData<AddonData>();

  Function ctor = DefineClass(env, "Tree", {
    InstanceMethod("edit", &Tree::Edit, napi_default_method),
    InstanceMethod("copy", &Tree::Copy, napi_default_method),
    InstanceMethod("rootNode", &Tree::RootNode, napi_default_method),
    InstanceMethod("rootNodeWithOffset", &Tree::RootNodeWithOffset, napi_default_method),
    InstanceMethod("printDotGraph", &Tree::PrintDotGraph, napi_default_method),
    InstanceMethod("getChangedRanges", &Tree::GetChangedRanges, napi_default_method),
    InstanceMethod("getIncludedRanges", &Tree::GetIncludedRanges, napi_default_method),
    InstanceMethod("getEditedRange", &Tree::GetEditedRange, napi_default_method),
    InstanceMethod("_cacheNode", &Tree::CacheNode, napi_default_method),
    InstanceMethod("_cacheNodes", &Tree::CacheNodes, napi_default_method),
  });

  data->tree_constructor = Napi::Persistent(ctor);
  exports["Tree"] = ctor;
}

Tree::Tree(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Tree>(info), tree_(nullptr) {
  if (!info.Env().GetInstanceData<AddonData>()->constructing_tree) {
    throw TypeError::New(info.Env(), "Trees are created by parsing or copying an existing tree");
  }
  Value().TypeTag(&TREE_TYPE_TAG);
}

Tree::~Tree() {
  ts_tree_delete(tree_);
  for (auto &entry : cached_nodes_) {
    for (auto *cached = entry.second; cached; cached = NextCached(cached)) cached->tree = nullptr;
  }
}

Napi::Value Tree::NewInstance(Napi::Env env, TSTree *tree) {
  auto *data = env.GetInstanceData<AddonData>();
  if (tree != nullptr) {
    OperationGuard construction(data->constructing_tree);
    Object self = data->tree_constructor.New({});
    Tree::Unwrap(self)->tree_ = tree;
    return self;
  }

  return env.Null();
}

const Tree *Tree::UnwrapTree(const Napi::Value &value) {
  if (!value.IsObject()) {
    return nullptr;
  }
  auto js_tree = value.As<Object>();
  if (!js_tree.CheckTypeTag(&TREE_TYPE_TAG)) {
    return nullptr;
  }
  return Tree::Unwrap(js_tree);
}

#define read_number_from_js(out, value, name) (*(out) = UnsignedInteger(value, UINT32_MAX, name))
#define read_byte_count_from_js(out, value, name) (*(out) = UnsignedInteger(value, UINT32_MAX / 2, name) * 2)

Napi::Value Tree::Copy(const Napi::CallbackInfo &info) {
  return NewInstance(info.Env(), ts_tree_copy(tree_));
}

Napi::Value Tree::Edit(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (snapshot_) throw TypeError::New(env, "Cannot edit an immutable parse snapshot; use copy()");
  if (active_readers_) throw TypeError::New(env, "Cannot edit a tree while a parser or query is reading it");
  TSInputEdit edit;
  read_number_from_js(&edit.start_point.row, info[0], "startPosition.row");
  read_byte_count_from_js(&edit.start_point.column, info[1], "startPosition.column");
  read_number_from_js(&edit.old_end_point.row, info[2], "oldEndPosition.row");
  read_byte_count_from_js(&edit.old_end_point.column, info[3], "oldEndPosition.column");
  read_number_from_js(&edit.new_end_point.row, info[4], "newEndPosition.row");
  read_byte_count_from_js(&edit.new_end_point.column, info[5], "newEndPosition.column");
  read_byte_count_from_js(&edit.start_byte, info[6], "startIndex");
  read_byte_count_from_js(&edit.old_end_byte, info[7], "oldEndIndex");
  read_byte_count_from_js(&edit.new_end_byte, info[8], "newEndIndex");

  auto ordered = [](TSPoint start, TSPoint end) { return start.row < end.row || (start.row == end.row && start.column <= end.column); };
  if (edit.start_byte > edit.old_end_byte || edit.start_byte > edit.new_end_byte ||
      !ordered(edit.start_point, edit.old_end_point) || !ordered(edit.start_point, edit.new_end_point)) {
    throw RangeError::New(env, "Edit endpoints must not precede their start");
  }
  ts_tree_edit(tree_, &edit);
  generation_++;

  for (auto &entry : cached_nodes_) {
    for (auto *cached = entry.second; cached; cached = NextCached(cached)) {
      Object js_node = cached->node.Value();
      if (js_node.IsEmpty()) continue;
      TSNode node{};
      node.tree = tree_;
      node.id = cached->key;
      for (unsigned i = 0; i < 4; i++) node.context[i] = js_node.Get(i + 2U).As<Number>().Uint32Value();
      ts_node_edit(&node, &edit);
      for (unsigned i = 0; i < 4; i++) {
        if (has_offset_views_) node_contexts_[cached].context[i] = node.context[i];
        js_node[i + 2U] = Number::New(env, node.context[i]);
      }
    }
  }

  return info.This();
}

Napi::Value Tree::CachedNode(const TSNode &node) const {
  auto found = cached_nodes_.find(node.id);
  if (found == cached_nodes_.end()) return Napi::Value();
  if (!has_offset_views_) return found->second->node.Value();
  const std::array<uint32_t, 4> context{node.context[0], node.context[1], node.context[2], node.context[3]};
  for (auto *entry = found->second; entry; entry = NextCached(entry)) {
    const auto saved = node_contexts_.find(entry);
    if (saved != node_contexts_.end() && saved->second.context == context) {
      auto value = entry->node.Value();
      if (!value.IsEmpty()) return value;
    }
  }
  return Napi::Value();
}

Napi::Value Tree::RootNode(const Napi::CallbackInfo &info) {
  return node_methods::MarshalNode(info, this, ts_tree_root_node(tree_));
}

Napi::Value Tree::RootNodeWithOffset(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  uint32_t offset_bytes = 0;
  TSPoint offset_extent = {0, UINT32_MAX};

  read_byte_count_from_js(&offset_bytes, info[0], "offsetBytes");
  read_number_from_js(&offset_extent.row, info[1], "offsetExtent.row");
  read_byte_count_from_js(&offset_extent.column, info[2], "offsetExtent.column");

  if (offset_bytes == 0 && offset_extent.row == 0 && offset_extent.column == 0) return RootNode(info);
  if (!has_offset_views_) {
    has_offset_views_ = true;
    for (auto &pair : cached_nodes_) {
      for (auto *entry = pair.second; entry; entry = NextCached(entry)) {
        auto value = entry->node.Value();
        if (value.IsEmpty()) continue;
        auto &context = node_contexts_[entry].context;
        for (unsigned i = 0; i < 4; i++) context[i] = value.Get(i + 2U).As<Number>().Uint32Value();
      }
    }
  }
  return node_methods::MarshalNode(info, this, ts_tree_root_node_with_offset(tree_, offset_bytes, offset_extent));
}

Napi::Value Tree::GetChangedRanges(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const Tree *other_tree = UnwrapTree(info[0]);
  if (other_tree == nullptr) {
    throw TypeError::New(env, "Argument must be a tree");
  }
  if (ts_tree_language(tree_) != ts_tree_language(other_tree->tree_)) {
    throw TypeError::New(env, "Changed ranges require trees from the same language");
  }

  uint32_t range_count;
  TSRange *ranges = ts_tree_get_changed_ranges(tree_, other_tree->tree_, &range_count);

  Array result = Array::New(env);
  for (size_t i = 0; i < range_count; i++) {
    result[i] = RangeToJS(env, ranges[i]);
  }

  free(ranges);

  return result;
}

Napi::Value Tree::GetIncludedRanges(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  uint32_t range_count;
  TSRange *ranges = ts_tree_included_ranges(tree_, &range_count);

  Array result = Array::New(env);
  for (size_t i = 0; i < range_count; i++) {
    result[i] = RangeToJS(env, ranges[i]);
  }

  free(ranges);

  return result;
}

Napi::Value Tree::GetEditedRange(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  TSNode root = ts_tree_root_node(tree_);
  if (!ts_node_has_changes(root)) {
    return env.Undefined();
  }
  TSRange result = {
    ts_node_start_point(root),
    ts_node_end_point(root),
    ts_node_start_byte(root),
    ts_node_end_byte(root),
  };

  TSTreeCursor cursor = ts_tree_cursor_new(root);

  while (true) {
    if (!ts_tree_cursor_goto_first_child(&cursor)) {
      break;
    }
    while (true) {
      TSNode node = ts_tree_cursor_current_node(&cursor);
      if (ts_node_has_changes(node)) {
        result.start_byte = ts_node_start_byte(node);
        result.start_point = ts_node_start_point(node);
        break;
      }
      if (!ts_tree_cursor_goto_next_sibling(&cursor)) {
        break;
      }
    }
  }

  while (ts_tree_cursor_goto_parent(&cursor)) {}

  while (true) {
    if (!ts_tree_cursor_goto_first_child(&cursor)) {
      break;
    }
    while (true) {
      TSNode node = ts_tree_cursor_current_node(&cursor);
      if (ts_node_has_changes(node)) {
        result.end_byte = ts_node_end_byte(node);
        result.end_point = ts_node_end_point(node);
      }

      if (!ts_tree_cursor_goto_next_sibling(&cursor)) {
        break;
      }
    }
  }

  ts_tree_cursor_delete(&cursor);
  return RangeToJS(env, result);
}

Napi::Value Tree::PrintDotGraph(const Napi::CallbackInfo &info) {
  int fd = fileno(stderr);

  if (info.Length() > 0) {
    if (!info[0].IsNumber()) {
      throw TypeError::New(info.Env(), "First argument must be a number");
    }
    fd = info[0].As<Number>().Int32Value();
  }

  ts_tree_print_dot_graph(tree_, fd);
  return info.This();
}

namespace {

void FinalizeNode(Napi::Env _env, Tree::NodeCacheEntry *cache_entry) {
  assert(!cache_entry->node.IsEmpty());
  cache_entry->node.Reset();
  if (cache_entry->tree != nullptr) {
    auto *tree = cache_entry->tree;
    auto &cache = tree->cached_nodes_;
    auto found = cache.find(cache_entry->key);
    if (!tree->has_offset_views_) {
      if (found != cache.end() && found->second == cache_entry) cache.erase(found);
    } else {
      auto *next = tree->NextCached(cache_entry);
      if (found != cache.end()) {
        auto **link = &found->second;
        while (*link && *link != cache_entry) {
          auto saved = tree->node_contexts_.find(*link);
          if (saved == tree->node_contexts_.end()) { link = nullptr; break; }
          link = &saved->second.next;
        }
        if (link && *link) *link = next;
        if (!found->second) cache.erase(found);
      }
      tree->node_contexts_.erase(cache_entry);
    }
  }
  delete cache_entry;
}

const uint32_t *TransferredFields(Napi::Env env, uint32_t offset) {
  auto *data = env.GetInstanceData<AddonData>();
  if (offset > data->transfer_buffer_length || data->transfer_buffer_length - offset < 6) {
    throw RangeError::New(env, "Invalid transferred node offset");
  }
  return data->transfer_buffer + offset;
}

void CacheNodeForTree(Tree *tree, Napi::Env env, Object js_node, const uint32_t *fields = nullptr) {
  uint32_t local_fields[6]{};
  if (!fields) {
    for (unsigned i = 0; i < (tree->has_offset_views_ ? 6U : 2U); i++) {
      auto value = js_node.Get(i);
      if (!value.IsNumber()) return;
      local_fields[i] = value.As<Number>().Uint32Value();
    }
    fields = local_fields;
  }
  const void *key = UnmarshalNodeId(fields);
  const std::array<uint32_t, 4> context{fields[2], fields[3], fields[4], fields[5]};
  auto found = tree->cached_nodes_.find(key);
  auto *head = found == tree->cached_nodes_.end() ? nullptr : found->second;
  if (head && !tree->has_offset_views_) return;
  for (auto *entry = head; entry; entry = tree->NextCached(entry)) {
    // Preserve the original weak-cache policy: a collected wrapper may still
    // have a pending finalizer. Let it unlink before caching its replacement.
    // Recreating native weak references here adds avoidable post-GC churn.
    auto saved = tree->node_contexts_.find(entry);
    if (saved != tree->node_contexts_.end() && saved->second.context == context) return;
  }
  auto *cache_entry = new Tree::NodeCacheEntry{tree, key, {}};
  if (tree->has_offset_views_) tree->node_contexts_[cache_entry] = Tree::NodeView{context, head};
  cache_entry->node = Napi::Weak(js_node);
  js_node.AddFinalizer(&FinalizeNode, cache_entry);

  tree->cached_nodes_[key] = cache_entry;
}

} // namespace

Napi::Value Tree::CacheNode(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (!info[0].IsObject()) {
    throw TypeError::New(env, "not an object");
  }

  const uint32_t *fields = info[1].IsUndefined() ? nullptr : TransferredFields(env, UnsignedInteger(info[1], UINT32_MAX, "Node offset"));
  CacheNodeForTree(this, env, info[0].As<Object>(), fields);
  return env.Undefined();
}

Napi::Value Tree::CacheNodes(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (!info[0].IsArray()) {
    throw TypeError::New(env, "not an array");
  }
  auto js_nodes = info[0].As<Array>();
  uint32_t length = js_nodes.Length();
  const uint32_t *offsets = nullptr;
  if (!info[1].IsUndefined()) {
    if (!info[1].IsTypedArray() || info[1].As<TypedArray>().TypedArrayType() != napi_uint32_array || info[1].As<Uint32Array>().ElementLength() != length) {
      throw TypeError::New(env, "Expected one transferred offset per node");
    }
    offsets = info[1].As<Uint32Array>().Data();
  }

  for (uint32_t i = 0; i < length; ++i) {
    Napi::Value js_node = js_nodes[i];
    if (!js_node.IsObject()) {
      throw TypeError::New(env, "not an object");
    }
    CacheNodeForTree(this, env, js_node.As<Object>(), offsets ? TransferredFields(env, offsets[i]) : nullptr);
  }

  return env.Undefined();
}

} // namespace node_tree_sitter

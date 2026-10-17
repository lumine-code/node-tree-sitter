#ifndef NODE_TREE_SITTER_TREE_H_
#define NODE_TREE_SITTER_TREE_H_

#include "./addon_data.h"
#include "tree_sitter/api.h"

#include <napi.h>
#include <unordered_map>
#include <array>

namespace node_tree_sitter {

class Tree final : public Napi::ObjectWrap<Tree> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  static Napi::Value NewInstance(Napi::Env env, TSTree *tree);
  static const Tree *UnwrapTree(const Napi::Value &value);

  explicit Tree(const Napi::CallbackInfo &);
  ~Tree() final;

  struct NodeCacheEntry {
    Tree *tree;
    const void *key;
    Napi::ObjectReference node;
  };
  struct NodeView {
    std::array<uint32_t, 4> context{};
    NodeCacheEntry *next = nullptr;
  };
  Napi::Value CachedNode(const TSNode &node) const;
  NodeCacheEntry *NextCached(NodeCacheEntry *entry) const {
    if (!has_offset_views_) return nullptr;
    auto found = node_contexts_.find(entry);
    return found == node_contexts_.end() ? nullptr : found->second.next;
  }

  TSTree *tree_;
  bool snapshot_ = false;
  uint64_t generation_ = 0;
  mutable uint32_t active_readers_ = 0;
  std::unordered_map<const void *, NodeCacheEntry *> cached_nodes_;
  bool has_offset_views_ = false;
  std::unordered_map<NodeCacheEntry *, NodeView> node_contexts_;

 private:
  Napi::Value Edit(const Napi::CallbackInfo &info);
  Napi::Value Copy(const Napi::CallbackInfo &info);
  Napi::Value RootNode(const Napi::CallbackInfo &info);
  Napi::Value RootNodeWithOffset(const Napi::CallbackInfo &info);
  Napi::Value PrintDotGraph(const Napi::CallbackInfo &info);
  Napi::Value GetEditedRange(const Napi::CallbackInfo &info);
  Napi::Value GetChangedRanges(const Napi::CallbackInfo &info);
  Napi::Value GetIncludedRanges(const Napi::CallbackInfo &info);
  Napi::Value CacheNode(const Napi::CallbackInfo &info);
  Napi::Value CacheNodes(const Napi::CallbackInfo &info);
};

struct TreeReadGuard {
  const Tree *tree;
  explicit TreeReadGuard(const Tree *value) : tree(value) { if (tree) tree->active_readers_++; }
  ~TreeReadGuard() { if (tree) tree->active_readers_--; }
};

} // namespace node_tree_sitter

#endif // NODE_TREE_SITTER_TREE_H_

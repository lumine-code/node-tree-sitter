#ifndef NODE_TREE_SITTER_OPERATION_H_
#define NODE_TREE_SITTER_OPERATION_H_
namespace node_tree_sitter {
// Reject re-entry before constructing this guard; always clear on exceptions.
struct OperationGuard {
  bool &active;
  explicit OperationGuard(bool &value) : active(value) { active = true; }
  ~OperationGuard() { active = false; }
};
}
#endif

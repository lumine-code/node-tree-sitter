#include "./query.h"
#include "./language.h"
#include "./node.h"
#include "./operation.h"
#include "./conversions.h"
#include <memory>
#include <cmath>

#include <napi.h>
#include <string>
#include <vector>
#include <chrono>

using std::vector;
using namespace Napi;

namespace node_tree_sitter {

/*
  tstag() {
    b2sum -l64 <(printf tree-sitter) <(printf "$1") | \
    awk '{printf "0x" toupper($1) (NR == 1 ? ", " : "\n")}'
  }
  tstag query # => 0x8AF2E5212AD58ABF, 0x7B1FAB666CBD6803
*/
const napi_type_tag QUERY_TYPE_TAG = {
  0x8AF2E5212AD58ABF, 0x7B1FAB666CBD6803
};

const char *query_error_names[] = {
  "TSQueryErrorNone",
  "TSQueryErrorSyntax",
  "TSQueryErrorNodeType",
  "TSQueryErrorField",
  "TSQueryErrorCapture",
  "TSQueryErrorStructure",
  "TSQueryErrorLanguage",
};

class CallbackProgress final {
 public:
  Napi::FunctionReference func;
  uint64_t timeout = 0;
  std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
  static bool Cancel(TSQueryCursorState *state) {
    auto *self = static_cast<CallbackProgress *>(state->payload);
    if (self->timeout && std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - self->start).count() >= self->timeout) return true;
    if (self->func.IsEmpty()) return false;
    auto env = self->func.Env();
    if (env.IsExceptionPending()) return true;
    try { return self->func({Number::New(env, state->current_byte_offset / 2)}).As<Boolean>(); }
    catch (const Napi::Error &error) { error.ThrowAsJavaScriptException(); return true; }
  }
};

void Query::Init(Napi::Env env, Napi::Object exports) {
  auto *data = env.GetInstanceData<AddonData>();


  Function ctor = DefineClass(env, "Query", {
    InstanceAccessor("matchLimit", &Query::MatchLimit, nullptr, napi_default_method),

    InstanceMethod("_matches", &Query::Matches, napi_default_method),
    InstanceMethod("_captures", &Query::Captures, napi_default_method),
    InstanceMethod("_getPredicates", &Query::GetPredicates, napi_default_method),
    InstanceMethod("disableCapture", &Query::DisableCapture, napi_default_method),
    InstanceMethod("disablePattern", &Query::DisablePattern, napi_default_method),
    InstanceMethod("isPatternGuaranteedAtStep", &Query::IsPatternGuaranteedAtStep, napi_default_method),
    InstanceMethod("isPatternRooted", &Query::IsPatternRooted, napi_default_method),
    InstanceMethod("isPatternNonLocal", &Query::IsPatternNonLocal, napi_default_method),
    InstanceMethod("startIndexForPattern", &Query::StartIndexForPattern, napi_default_method),
    InstanceMethod("endIndexForPattern", &Query::EndIndexForPattern, napi_default_method),
    InstanceMethod("didExceedMatchLimit", &Query::DidExceedMatchLimit, napi_default_method),
  });

  data->query_constructor = Napi::Persistent(ctor);
  exports["Query"] = ctor;
}

Query::Query(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Query>(info) , query_(nullptr) {
  Napi::Env env = info.Env();

  Value().TypeTag(&QUERY_TYPE_TAG);

  const TSLanguage *language = language_methods::UnwrapLanguage(info[0]);
  const char *source;
  uint32_t source_len;
  uint32_t error_offset = 0;
  TSQueryError error_type = TSQueryErrorNone;

  if (language == nullptr) {
    throw Error::New(env, "Missing language argument");
  }

  if (info[1].IsString()) {
    auto string = info[1].As<String>();
    std::string utf8_string = string.Utf8Value();
    source = utf8_string.data();
    source_len = utf8_string.length();
    query_ = ts_query_new(language, source, source_len, &error_offset, &error_type);
  } else if (info[1].IsBuffer()) {
    auto buf = info[1].As<Buffer<char>>();
    source = buf.Data();
    source_len = buf.Length();
    query_ = ts_query_new(language, source, source_len, &error_offset, &error_type);
  }
  else {
    throw Error::New(env, "Missing source argument");
  }

  if (!query_) {
    const char *error_name = query_error_names[error_type];
    std::string message = "Query error of type ";
    message += error_name;
    message += " at position ";
    message += std::to_string(error_offset);
    auto error = Error::New(env, message.c_str());
    error.Set("offset", Number::New(env, error_offset));
    error.Set("kind", Number::New(env, static_cast<int>(error_type)));
    throw error;
  }

  info.This().As<Napi::Object>().Get("_init").As<Napi::Function>().Call(info.This(), {});
}

Query::~Query() {
  ts_query_delete(query_);
}

Query *Query::UnwrapQuery(const Napi::Value &value) {
  if (!value.IsObject()) {
    return nullptr;
  }
  auto js_query = value.As<Object>();
  if (!js_query.CheckTypeTag(&QUERY_TYPE_TAG)) {
    return nullptr;
  }
  return Query::Unwrap(js_query);
}

Napi::Value Query::GetPredicates(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Query *query = Query::UnwrapQuery(info.This());
  auto *ts_query = query->query_;

  auto pattern_len = ts_query_pattern_count(ts_query);

  Array js_predicates = Array::New(env);

  for (size_t pattern_index = 0; pattern_index < pattern_len; pattern_index++) {
    uint32_t predicates_len;
    const TSQueryPredicateStep *predicates = ts_query_predicates_for_pattern(
        ts_query, pattern_index, &predicates_len);

    Array js_pattern_predicates = Array::New(env);

    if (predicates_len > 0) {
      Array js_predicate = Array::New(env);

      size_t a_index = 0;
      size_t p_index = 0;
      for (size_t i = 0; i < predicates_len; i++) {
        const TSQueryPredicateStep predicate = predicates[i];
        uint32_t len;
        switch (predicate.type) {
          case TSQueryPredicateStepTypeCapture:
            js_predicate[p_index++] = Number::New(env, TSQueryPredicateStepTypeCapture);
            js_predicate[p_index++] = String::New(env,
              ts_query_capture_name_for_id(ts_query, predicate.value_id, &len)
            );
            break;
          case TSQueryPredicateStepTypeString:
            js_predicate[p_index++] = Number::New(env, TSQueryPredicateStepTypeString);
            js_predicate[p_index++] = String::New(env,
              ts_query_string_value_for_id(ts_query, predicate.value_id, &len)
            );
            break;
          case TSQueryPredicateStepTypeDone:
            js_pattern_predicates[a_index++] = js_predicate;
            js_predicate = Array::New(env);
            p_index = 0;
            break;
        }
      }
    }

    js_predicates[pattern_index] = js_pattern_predicates;
  }

  return js_predicates;
}

Napi::Value Query::Matches(const Napi::CallbackInfo &info) {
  if (executing_) throw Error::New(info.Env(), "Cannot re-enter an active query");
  OperationGuard operation(executing_);
  std::unique_ptr<TSQueryCursor, decltype(&ts_query_cursor_delete)> owned_cursor(ts_query_cursor_new(), ts_query_cursor_delete);
  auto *cursor = owned_cursor.get();
  Napi::Env env = info.Env();
  auto *data = env.GetInstanceData<AddonData>();
  Query *query = Query::UnwrapQuery(info.This());
  const Tree *tree = Tree::UnwrapTree(info[0]);

  uint32_t start_row = 0, start_column = 0, end_row = 0, end_column = 0, start_index = 0, end_index = 0,
             match_limit = UINT32_MAX, max_start_depth = UINT32_MAX, timeout_micros = 0;

  if (info.Length() > 1 && !info[1].IsUndefined()) {
    const auto value = UnsignedInteger(info[1], UINT32_MAX, "start_row", true);
    start_row = value;
  }
  if (info.Length() > 2 && !info[2].IsUndefined()) {
    const auto value = UnsignedInteger(info[2], UINT32_MAX / 2, "start_column", true);
    start_column = (value == UINT32_MAX ? value : value * 2);
  }
  if (info.Length() > 3 && !info[3].IsUndefined()) {
    const auto value = UnsignedInteger(info[3], UINT32_MAX, "end_row", true);
    end_row = value;
  }
  if (info.Length() > 4 && !info[4].IsUndefined()) {
    const auto value = UnsignedInteger(info[4], UINT32_MAX / 2, "end_column", true);
    end_column = (value == UINT32_MAX ? value : value * 2);
  }
  if (info.Length() > 5 && !info[5].IsUndefined()) {
    const auto value = UnsignedInteger(info[5], UINT32_MAX / 2, "start_index", false);
    start_index = value * 2;
  }
  if (info.Length() > 6 && !info[6].IsUndefined()) {
    const auto value = UnsignedInteger(info[6], UINT32_MAX / 2, "end_index", false);
    end_index = value * 2;
  }
  if (info.Length() > 7 && !info[7].IsUndefined()) {
    const auto value = UnsignedInteger(info[7], UINT32_MAX, "match_limit", false);
    match_limit = value;
  }
  if (info.Length() > 8 && !info[8].IsUndefined()) {
    const auto value = UnsignedInteger(info[8], UINT32_MAX, "max_start_depth", true);
    max_start_depth = value;
  }
  if (info.Length() > 9 && !info[9].IsUndefined()) {
    const auto value = UnsignedInteger(info[9], UINT32_MAX, "timeout_micros", false);
    timeout_micros = value;
  }

  if (query == nullptr) {
    throw Error::New(env, "Missing argument query");
  }

  if (tree == nullptr) {
    throw Error::New(env, "Missing argument tree");
  }

  TreeReadGuard reading(tree);
  TSQuery *ts_query = query->query_;
  TSNode root_node = node_methods::UnmarshalNode(env, tree);
  TSPoint start_point = {start_row, start_column};
  TSPoint end_point = {end_row, end_column};
  if (!ts_query_cursor_set_point_range(cursor, start_point, end_point)) throw RangeError::New(env, "Invalid query point range");
  if (!ts_query_cursor_set_byte_range(cursor, start_index, end_index)) throw RangeError::New(env, "Invalid query index range");
  ts_query_cursor_set_match_limit(cursor, match_limit);
  ts_query_cursor_set_max_start_depth(cursor, max_start_depth);
  CallbackProgress progress;
  progress.timeout = timeout_micros;
  if (info.Length() > 10 && !info[10].IsUndefined() && !info[10].IsNull()) {
    if (!info[10].IsFunction()) throw TypeError::New(env, "progressCallback must be a function");
    progress.func = Napi::Persistent(info[10].As<Function>());
  }
  TSQueryCursorOptions options{&progress, CallbackProgress::Cancel};
  ts_query_cursor_exec_with_options(cursor, ts_query, root_node, &options);

  Array js_matches = Array::New(env);
  unsigned index = 0;
  vector<TSNode> nodes;
  TSQueryMatch match;

  while (ts_query_cursor_next_match(cursor, &match)) {
    js_matches[index++] = Number::New(env, match.pattern_index);

    for (uint16_t i = 0; i < match.capture_count; i++) {
      const TSQueryCapture &capture = match.captures[i];

      uint32_t capture_name_len = 0;
      const char *capture_name = ts_query_capture_name_for_id(
          ts_query, capture.index, &capture_name_len);

      TSNode node = capture.node;
      nodes.push_back(node);

      String js_capture = String::New(env, capture_name);;
      js_matches[index++] = js_capture;
    }
  }

  last_match_limit_ = ts_query_cursor_match_limit(cursor);
  last_exceeded_match_limit_ = ts_query_cursor_did_exceed_match_limit(cursor);
  if (env.IsExceptionPending()) return env.Undefined();
  auto js_nodes = node_methods::GetMarshalNodes(info, tree, nodes.data(), nodes.size());

  auto result = Array::New(env);
  result[0U] = js_matches;
  result[1] = js_nodes;
  return result;
}

Napi::Value Query::Captures(const Napi::CallbackInfo &info) {
  if (executing_) throw Error::New(info.Env(), "Cannot re-enter an active query");
  OperationGuard operation(executing_);
  std::unique_ptr<TSQueryCursor, decltype(&ts_query_cursor_delete)> owned_cursor(ts_query_cursor_new(), ts_query_cursor_delete);
  auto *cursor = owned_cursor.get();
  Napi::Env env = info.Env();
  auto *data = env.GetInstanceData<AddonData>();
  Query *query = Query::UnwrapQuery(info.This());
  const Tree *tree = Tree::UnwrapTree(info[0]);

  uint32_t start_row = 0, start_column = 0, end_row = 0, end_column = 0, start_index = 0, end_index = 0,
             match_limit = UINT32_MAX, max_start_depth = UINT32_MAX, timeout_micros = 0;

  if (info.Length() > 1 && !info[1].IsUndefined()) {
    const auto value = UnsignedInteger(info[1], UINT32_MAX, "start_row", true);
    start_row = value;
  }
  if (info.Length() > 2 && !info[2].IsUndefined()) {
    const auto value = UnsignedInteger(info[2], UINT32_MAX / 2, "start_column", true);
    start_column = (value == UINT32_MAX ? value : value * 2);
  }
  if (info.Length() > 3 && !info[3].IsUndefined()) {
    const auto value = UnsignedInteger(info[3], UINT32_MAX, "end_row", true);
    end_row = value;
  }
  if (info.Length() > 4 && !info[4].IsUndefined()) {
    const auto value = UnsignedInteger(info[4], UINT32_MAX / 2, "end_column", true);
    end_column = (value == UINT32_MAX ? value : value * 2);
  }
  if (info.Length() > 5 && !info[5].IsUndefined()) {
    const auto value = UnsignedInteger(info[5], UINT32_MAX / 2, "start_index", false);
    start_index = value * 2;
  }
  if (info.Length() > 6 && !info[6].IsUndefined()) {
    const auto value = UnsignedInteger(info[6], UINT32_MAX / 2, "end_index", false);
    end_index = value * 2;
  }
  if (info.Length() > 7 && !info[7].IsUndefined()) {
    const auto value = UnsignedInteger(info[7], UINT32_MAX, "match_limit", false);
    match_limit = value;
  }
  if (info.Length() > 8 && !info[8].IsUndefined()) {
    const auto value = UnsignedInteger(info[8], UINT32_MAX, "max_start_depth", true);
    max_start_depth = value;
  }
  if (info.Length() > 9 && !info[9].IsUndefined()) {
    const auto value = UnsignedInteger(info[9], UINT32_MAX, "timeout_micros", false);
    timeout_micros = value;
  }

  if (query == nullptr) {
    throw Error::New(env, "Missing argument query");
  }

  if (tree == nullptr) {
    throw Error::New(env, "Missing argument tree");
  }

  TreeReadGuard reading(tree);
  TSQuery *ts_query = query->query_;
  TSNode root_node = node_methods::UnmarshalNode(env, tree);
  TSPoint start_point = {start_row, start_column};
  TSPoint end_point = {end_row, end_column};
  if (!ts_query_cursor_set_point_range(cursor, start_point, end_point)) throw RangeError::New(env, "Invalid query point range");
  if (!ts_query_cursor_set_byte_range(cursor, start_index, end_index)) throw RangeError::New(env, "Invalid query index range");
  ts_query_cursor_set_match_limit(cursor, match_limit);
  ts_query_cursor_set_max_start_depth(cursor, max_start_depth);
  CallbackProgress progress;
  progress.timeout = timeout_micros;
  if (info.Length() > 10 && !info[10].IsUndefined() && !info[10].IsNull()) {
    if (!info[10].IsFunction()) throw TypeError::New(env, "progressCallback must be a function");
    progress.func = Napi::Persistent(info[10].As<Function>());
  }
  TSQueryCursorOptions options{&progress, CallbackProgress::Cancel};
  ts_query_cursor_exec_with_options(cursor, ts_query, root_node, &options);

  Array js_matches = Array::New(env);
  unsigned index = 0;
  vector<TSNode> nodes;
  TSQueryMatch match;
  uint32_t capture_index;
  std::vector<bool> needs_context(ts_query_pattern_count(ts_query), true);
  if (info.Length() > 11 && info[11].IsArray()) {
    auto flags = info[11].As<Array>();
    for (uint32_t i = 0; i < needs_context.size(); i++) {
      auto flag = flags.Get(i);
      if (flag.IsBoolean()) needs_context[i] = flag.As<Boolean>().Value();
    }
  }

  while (ts_query_cursor_next_capture(
    cursor,
    &match,
    &capture_index
  )) {

    js_matches[index++] = Number::New(env, match.pattern_index);
    const bool context = needs_context[match.pattern_index];
    js_matches[index++] = Number::New(env, context ? capture_index : 0);

    // Predicateless patterns only need the emitted capture. Repeating the entire
    // match per capture creates quadratic JS arrays for quantified patterns.
    const uint32_t count = context ? match.capture_count : 1;
    for (uint32_t i = 0; i < count; i++) {
      const TSQueryCapture &capture = match.captures[context ? i : capture_index];

      uint32_t capture_name_len = 0;
      const char *capture_name = ts_query_capture_name_for_id(
          ts_query, capture.index, &capture_name_len);

      TSNode node = capture.node;
      nodes.push_back(node);

      String js_capture = String::New(env, capture_name);;
      js_matches[index++] = js_capture;
    }
  }

  last_match_limit_ = ts_query_cursor_match_limit(cursor);
  last_exceeded_match_limit_ = ts_query_cursor_did_exceed_match_limit(cursor);
  if (env.IsExceptionPending()) return env.Undefined();
  auto js_nodes = node_methods::GetMarshalNodes(info, tree, nodes.data(), nodes.size());

  auto result = Array::New(env);
  result[0U] = js_matches;
  result[1] = js_nodes;
  return result;
}

uint32_t Query::PatternIndex(const Napi::CallbackInfo &info) {
  if (!info[0].IsNumber()) throw TypeError::New(info.Env(), "Pattern index must be an integer");
  double value = info[0].As<Number>().DoubleValue();
  if (!std::isfinite(value) || std::floor(value) != value || value < 0 || value >= ts_query_pattern_count(query_)) {
    throw RangeError::New(info.Env(), "Pattern index is out of range");
  }
  return static_cast<uint32_t>(value);
}

Napi::Value Query::DisableCapture(const Napi::CallbackInfo &info) {
  if (executing_) throw Error::New(info.Env(), "Cannot modify an active query");
  std::string string = info[0].As<String>().Utf8Value();
  const char *capture_name = string.c_str();
  ts_query_disable_capture(query_, capture_name, string.length());
  return info.Env().Undefined();
}

Napi::Value Query::DisablePattern(const Napi::CallbackInfo &info) {
  if (executing_) throw Error::New(info.Env(), "Cannot modify an active query");
  uint32_t pattern_index = PatternIndex(info);
  ts_query_disable_pattern(query_, pattern_index);
  return info.Env().Undefined();
}

Napi::Value Query::IsPatternGuaranteedAtStep(const Napi::CallbackInfo &info) {
  uint32_t byte_offset = info[0].As<Number>().Uint32Value();
  return Boolean::New(info.Env(), ts_query_is_pattern_guaranteed_at_step(query_, byte_offset));
}

Napi::Value Query::IsPatternRooted(const Napi::CallbackInfo &info) {
  uint32_t pattern_index = PatternIndex(info);
  return Boolean::New(info.Env(), ts_query_is_pattern_rooted(query_, pattern_index));
}

Napi::Value Query::IsPatternNonLocal(const Napi::CallbackInfo &info) {
  uint32_t pattern_index = PatternIndex(info);
  return Boolean::New(info.Env(), ts_query_is_pattern_non_local(query_, pattern_index));
}

Napi::Value Query::StartIndexForPattern(const Napi::CallbackInfo &info) {
  uint32_t pattern_index = PatternIndex(info);
  return Number::New(info.Env(), ts_query_start_byte_for_pattern(query_, pattern_index));
}

Napi::Value Query::EndIndexForPattern(const Napi::CallbackInfo &info) {
  uint32_t pattern_index = PatternIndex(info);
  return Number::New(info.Env(), ts_query_end_byte_for_pattern(query_, pattern_index));
}

Napi::Value Query::DidExceedMatchLimit(const Napi::CallbackInfo &info) {
  auto *data = info.Env().GetInstanceData<AddonData>();
  return Boolean::New(info.Env(), last_exceeded_match_limit_);
}

Napi::Value Query::MatchLimit(const Napi::CallbackInfo &info) {
  auto *data = info.Env().GetInstanceData<AddonData>();
  return Number::New(info.Env(), last_match_limit_);
}

} // namespace node_tree_sitter

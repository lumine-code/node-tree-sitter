#include "./wasm.h"
#include "./addon_data.h"
#include "./language.h"
#include "./tree.h"
#include "./conversions.h"
#include <atomic>
#include <cstdlib>
#include <stdexcept>
#include <limits>
#include <vector>

namespace node_tree_sitter {
namespace {
std::string WasmMessage(TSWasmError &error) {
  std::string message = error.message ? error.message : "Tree-sitter Wasm operation failed";
  std::free(error.message);
  return message;
}
Napi::Error AbortError(Napi::Env env) {
  auto error = Napi::Error::New(env, "Parsing was cancelled");
  error.Set("name", "AbortError");
  return error;
}
const napi_type_tag LANGUAGE_TAG = {0x8AF2E5212AD58ABF, 0xD5006CAD83ABBA16};

class LoadLanguageJob final : public Napi::AsyncWorker {
 public:
  LoadLanguageJob(Napi::Env env, std::string name, Napi::Buffer<uint8_t> bytes)
    : AsyncWorker(env, "TreeSitter.loadLanguage"), deferred(Napi::Promise::Deferred::New(env)),
      engine(GetWasmEngine(env)), name(std::move(name)), bytes(bytes.Data(), bytes.Data() + bytes.Length()) {}
  ~LoadLanguageJob() override { if (language) ts_language_delete(language); }
  void Execute() override {
    try {
      std::unique_ptr<TSWasmStore, decltype(&ts_wasm_store_delete)> store(NewWasmStore(engine), ts_wasm_store_delete);
      TSWasmError error{};
      language = ts_wasm_store_load_language(store.get(), name.c_str(), reinterpret_cast<const char *>(bytes.data()), static_cast<uint32_t>(bytes.size()), &error);
      if (!language) SetError(WasmMessage(error));
    } catch (const std::exception &error) { SetError(error.what()); }
  }
  void OnOK() override {
    auto external = Napi::External<TSLanguage>::New(Env(), const_cast<TSLanguage *>(language),
      [](Napi::Env, TSLanguage *value) { ts_language_delete(value); });
    external.TypeTag(&LANGUAGE_TAG);
    language = nullptr;
    auto result = Napi::Object::New(Env());
    result.Set("language", external);
    result.Set("name", name);
    result.Set("wasm", true);
    deferred.Resolve(result);
  }
  void OnError(const Napi::Error &error) override { deferred.Reject(error.Value()); }
  Napi::Promise::Deferred deferred;
 private:
  WasmEngine engine;
  std::string name;
  std::vector<uint8_t> bytes;
  const TSLanguage *language = nullptr;
};

struct ParserState {
  WasmEngine engine;
  TSParser *parser = nullptr;
  std::atomic<bool> cancelled{false};
  bool busy = false; // Accessed only on the owning JS thread.
  bool closed = false;
  explicit ParserState(WasmEngine value) : engine(std::move(value)), parser(ts_parser_new()) {}
  ~ParserState() { ts_parser_delete(parser); }
  void ReleaseClosedParser() {
    if (closed && !busy && parser) {
      ts_parser_delete(parser);
      parser = nullptr;
    }
  }
};

class ParseJob final : public Napi::AsyncWorker {
 public:
  ParseJob(Napi::Env env, std::shared_ptr<ParserState> state, std::u16string text, TSTree *old_tree)
    : AsyncWorker(env, "TreeSitter.parse"), deferred(Napi::Promise::Deferred::New(env)),
      state(std::move(state)), text(std::move(text)), old_tree(old_tree) {
    napi_add_env_cleanup_hook(env, Cleanup, this);
  }
  ~ParseJob() override {
    if (!cleaned_up) napi_remove_env_cleanup_hook(Env(), Cleanup, this);
    ts_tree_delete(old_tree);
    ts_tree_delete(result);
  }
  static void Cleanup(void *data) {
    auto *self = static_cast<ParseJob *>(data);
    self->cleaned_up = true;
    self->state->cancelled.store(true, std::memory_order_relaxed);
  }
  static const char *Read(void *payload, uint32_t byte, TSPoint, uint32_t *length) {
    auto &text = static_cast<ParseJob *>(payload)->text;
    const auto size = static_cast<uint32_t>(text.size() * sizeof(char16_t));
    *length = byte < size ? size - byte : 0;
    return *length ? reinterpret_cast<const char *>(text.data()) + byte : nullptr;
  }
  static bool Progress(TSParseState *progress) {
    return static_cast<ParserState *>(progress->payload)->cancelled.load(std::memory_order_relaxed);
  }
  void Execute() override {
    if (state->cancelled.load(std::memory_order_relaxed)) return;
    TSInput input{};
    input.payload = this;
    input.read = Read;
    input.encoding = TSInputEncodingUTF16LE;
    TSParseOptions options{state.get(), Progress};
    result = ts_parser_parse_with_options(state->parser, old_tree, input, options);
    // A cancelled parse must never resume against the next request's input.
    ts_parser_reset(state->parser);
  }
  void OnOK() override {
    state->busy = false;
    state->ReleaseClosedParser();
    if (state->cancelled.load(std::memory_order_relaxed)) {
      deferred.Reject(AbortError(Env()).Value());
    } else if (!result) {
      deferred.Reject(Napi::Error::New(Env(), "Tree-sitter parse failed").Value());
    } else {
      auto tree = Tree::NewInstance(Env(), result);
      Tree::Unwrap(tree.As<Napi::Object>())->snapshot_ = true;
      result = nullptr;
      deferred.Resolve(tree);
    }
  }
  void OnError(const Napi::Error &error) override {
    state->busy = false;
    state->ReleaseClosedParser();
    deferred.Reject(error.Value());
  }
  Napi::Promise::Deferred deferred;
 private:
  std::shared_ptr<ParserState> state;
  std::u16string text;
  TSTree *old_tree;
  TSTree *result = nullptr;
  bool cleaned_up = false;
};

class BackgroundParser final : public Napi::ObjectWrap<BackgroundParser> {
 public:
  explicit BackgroundParser(const Napi::CallbackInfo &info) : ObjectWrap(info) {
    auto language = language_methods::UnwrapLanguage(info[0]);
    state = std::make_shared<ParserState>(GetWasmEngine(info.Env()));
    try {
      if (ts_language_is_wasm(language)) ts_parser_set_wasm_store(state->parser, NewWasmStore(state->engine));
    } catch (const std::exception &error) { throw Napi::Error::New(info.Env(), error.what()); }
    if (!ts_parser_set_language(state->parser, language)) throw Napi::Error::New(info.Env(), "Cannot assign parser language");
  }
  ~BackgroundParser() override { state->cancelled.store(true, std::memory_order_relaxed); }
  Napi::Value Parse(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    if (state->closed) throw Napi::Error::New(env, "Parser is closed");
    if (state->busy) throw Napi::Error::New(env, "Parser already has an active parse");
    if (!info[0].IsString()) throw Napi::TypeError::New(env, "Background parsing requires a string snapshot");
    std::u16string text = info[0].As<Napi::String>().Utf16Value();
    if (text.size() > UINT32_MAX / 2) throw Napi::RangeError::New(env, "Input exceeds Tree-sitter's offset limit");
    const Tree *old = nullptr;
    if (!info[1].IsNull() && !info[1].IsUndefined()) {
      old = Tree::UnwrapTree(info[1]);
      if (!old || ts_tree_language(old->tree_) != ts_parser_language(state->parser)) {
        throw Napi::TypeError::New(env, "Previous tree belongs to a different language");
      }
    }
    std::vector<TSRange> ranges;
    if (!info[2].IsUndefined()) {
      if (!info[2].IsArray()) throw Napi::TypeError::New(env, "includedRanges must be an array");
      auto array = info[2].As<Napi::Array>();
      for (uint32_t i = 0; i < array.Length(); i++) {
        auto range = RangeFromJS(array.Get(i));
        if (range.IsNothing()) return env.Undefined();
        ranges.push_back(range.Unwrap());
      }
    }
    if (!ts_parser_set_included_ranges(state->parser, ranges.data(), static_cast<uint32_t>(ranges.size()))) {
      throw Napi::RangeError::New(env, "Invalid included ranges");
    }
    auto *job = new ParseJob(env, state, std::move(text), old ? ts_tree_copy(old->tree_) : nullptr);
    state->cancelled.store(false, std::memory_order_relaxed);
    state->busy = true;
    auto promise = job->deferred.Promise();
    job->Queue();
    return promise;
  }
  Napi::Value Cancel(const Napi::CallbackInfo &info) {
    state->cancelled.store(true, std::memory_order_relaxed);
    return info.Env().Undefined();
  }
  Napi::Value Close(const Napi::CallbackInfo &info) {
    state->closed = true;
    state->ReleaseClosedParser();
    return Cancel(info);
  }
  static void Init(Napi::Env env, Napi::Object exports) {
    exports.Set("BackgroundParser", DefineClass(env, "BackgroundParser", {
      InstanceMethod("parse", &BackgroundParser::Parse),
      InstanceMethod("cancel", &BackgroundParser::Cancel),
      InstanceMethod("close", &BackgroundParser::Close),
    }));
  }
 private:
  std::shared_ptr<ParserState> state;
};
}

WasmEngine GetWasmEngine(Napi::Env env) {
  auto *data = env.GetInstanceData<AddonData>();
  if (!data->wasm_engine) data->wasm_engine = WasmEngine(wasm_engine_new(), wasm_engine_delete);
  if (!data->wasm_engine) throw Napi::Error::New(env, "Cannot create Wasmtime engine");
  return data->wasm_engine;
}
TSWasmStore *NewWasmStore(const WasmEngine &engine) {
  TSWasmError error{};
  auto *store = ts_wasm_store_new(engine.get(), &error);
  if (!store) throw std::runtime_error(WasmMessage(error));
  return store;
}
void InitWasm(Napi::Env env, Napi::Object exports) {
  exports.Set("loadWasmLanguage", Napi::Function::New(env, [](const Napi::CallbackInfo &info) -> Napi::Value {
    if (!info[0].IsString() || !info[1].IsBuffer()) throw Napi::TypeError::New(info.Env(), "Expected a language name and Wasm Buffer");
    auto name = info[0].As<Napi::String>().Utf8Value();
    if (name.empty() || name.find('\0') != std::string::npos) throw Napi::TypeError::New(info.Env(), "Invalid language name");
    auto bytes = info[1].As<Napi::Buffer<uint8_t>>();
    if (bytes.Length() > UINT32_MAX) throw Napi::RangeError::New(info.Env(), "Wasm module is too large");
    auto *job = new LoadLanguageJob(info.Env(), std::move(name), bytes);
    auto promise = job->deferred.Promise();
    job->Queue();
    return promise;
  }));
  BackgroundParser::Init(env, exports);
}
}

#include "./conversions.h"
#include "./language.h"
#include "./lookaheaditerator.h"
#include "tree_sitter/api.h"

#include <napi.h>

using namespace Napi;

namespace node_tree_sitter {
const napi_type_tag LOOKAHEAD_TYPE_TAG = {0x8AF2E5212AD58ABF, 0x4C6F6F6B41686561};

void LookaheadIterator::Init(Napi::Env env, Napi::Object exports) {
  auto *data = env.GetInstanceData<AddonData>();

  Function ctor = DefineClass(env, "LookaheadIterator", {
    InstanceAccessor("currentTypeId", &LookaheadIterator::CurrentTypeId, nullptr, napi_default_method),
    InstanceAccessor("currentType", &LookaheadIterator::CurrentType, nullptr, napi_default_method),

    InstanceMethod("reset", &LookaheadIterator::Reset, napi_default_method),
    InstanceMethod("resetState", &LookaheadIterator::ResetState, napi_default_method),
    InstanceMethod("_next", &LookaheadIterator::Next, napi_default_method),
  });

  exports["LookaheadIterator"] = ctor;
  data->lookahead_iterator_constructor = Napi::Persistent(ctor);
}

LookaheadIterator::LookaheadIterator(const Napi::CallbackInfo &info) : Napi::ObjectWrap<LookaheadIterator>(info), iterator_(nullptr) {
  Napi::Env env = info.Env();
  Value().TypeTag(&LOOKAHEAD_TYPE_TAG);
  const TSLanguage *language = language_methods::UnwrapLanguage(info[0]);

  if (language == nullptr) {
    Napi::Error::New(env, "Missing language argument").ThrowAsJavaScriptException();
    return;
  }
  if (!info[1].IsNumber()) {
    Napi::Error::New(env, "Missing state argument").ThrowAsJavaScriptException();
    return;
  }

  TSStateId state = static_cast<TSStateId>(UnsignedInteger(info[1], UINT16_MAX, "Parse state"));
  iterator_ = ts_lookahead_iterator_new(language, state);
  if (iterator_ == nullptr) {
    Napi::Error::New(env, "Invalid state argument").ThrowAsJavaScriptException();
    return;
  }
}


LookaheadIterator::~LookaheadIterator() {
  ts_lookahead_iterator_delete(iterator_);
}

LookaheadIterator *LookaheadIterator::UnwrapLookaheadIterator(const Napi::Value &value) {
  auto *data = value.Env().GetInstanceData<AddonData>();
  if (!value.IsObject()) {
    return nullptr;
  }
  auto js_iterator = value.As<Object>();
  if (!js_iterator.CheckTypeTag(&LOOKAHEAD_TYPE_TAG)) {
    return nullptr;
  }
  return LookaheadIterator::Unwrap(js_iterator);
}

Napi::Value LookaheadIterator::CurrentType(const Napi::CallbackInfo &info) {
  LookaheadIterator *iterator = UnwrapLookaheadIterator(info.This());
  if (iterator == nullptr) {
    Napi::TypeError::New(info.Env(), "Receiver must be a LookaheadIterator").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  return Napi::String::New(info.Env(), ts_lookahead_iterator_current_symbol_name(iterator->iterator_));
}

Napi::Value LookaheadIterator::CurrentTypeId(const Napi::CallbackInfo &info) {
  LookaheadIterator *iterator = UnwrapLookaheadIterator(info.This());
  if (iterator == nullptr) {
    Napi::TypeError::New(info.Env(), "Receiver must be a LookaheadIterator").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  return Napi::Number::New(info.Env(), ts_lookahead_iterator_current_symbol(iterator->iterator_));
}

Napi::Value LookaheadIterator::Reset(const Napi::CallbackInfo &info) {
  LookaheadIterator *iterator = UnwrapLookaheadIterator(info.This());
  if (iterator == nullptr) {
    Napi::TypeError::New(info.Env(), "Receiver must be a LookaheadIterator").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  const TSLanguage *language = language_methods::UnwrapLanguage(info[0]);

  if (language == nullptr) {
    Napi::Error::New(info.Env(), "Invalid language argument").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  if (!info[1].IsNumber()) {
    Napi::Error::New(info.Env(), "Missing state argument").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }

  TSStateId state = static_cast<TSStateId>(UnsignedInteger(info[1], UINT16_MAX, "Parse state"));
  return Napi::Boolean::New(info.Env(), ts_lookahead_iterator_reset(iterator->iterator_, language, state));
}

Napi::Value LookaheadIterator::ResetState(const Napi::CallbackInfo &info) { 
  Napi::Env env = info.Env();
  LookaheadIterator *iterator = UnwrapLookaheadIterator(info.This());
  if (iterator == nullptr) {
    Napi::TypeError::New(env, "Receiver must be a LookaheadIterator").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[0].IsNumber()) {
    Napi::Error::New(env, "Missing state argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  TSStateId state = static_cast<TSStateId>(UnsignedInteger(info[0], UINT16_MAX, "Parse state"));
  return Napi::Boolean::New(env, ts_lookahead_iterator_reset_state(iterator->iterator_, state));
}

Napi::Value LookaheadIterator::Next(const Napi::CallbackInfo &info) {
  LookaheadIterator *iterator = UnwrapLookaheadIterator(info.This());
  if (iterator == nullptr) {
    Napi::TypeError::New(info.Env(), "Receiver must be a LookaheadIterator").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  return Napi::Boolean::New(info.Env(), ts_lookahead_iterator_next(iterator->iterator_));
}

} // namespace node_tree_sitter

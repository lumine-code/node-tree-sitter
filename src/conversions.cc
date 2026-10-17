#include "./conversions.h"
#include "./addon_data.h"
#include "tree_sitter/api.h"

#include <cmath>
#include <napi.h>

using namespace Napi;

namespace node_tree_sitter {

static const unsigned BYTES_PER_CHARACTER = 2;

uint32_t UnsignedInteger(const Napi::Value &value, uint32_t maximum, const char *name, bool allow_infinity) {
  if (!value.IsNumber()) throw TypeError::New(value.Env(), std::string(name) + " must be a number");
  const double number = value.As<Number>().DoubleValue();
  if (allow_infinity && number == INFINITY) return UINT32_MAX;
  if (!std::isfinite(number) || std::floor(number) != number || number < 0 || number > maximum) {
    throw RangeError::New(value.Env(), std::string(name) + " must be a nonnegative integer in range");
  }
  return static_cast<uint32_t>(number);
}

void InitConversions(Napi::Env env, Napi::Object exports) {
  auto *data = env.GetInstanceData<AddonData>();

  auto js_point_transfer_buffer = Uint32Array::New(env, 2);
  data->point_transfer_buffer = js_point_transfer_buffer.Data();

  exports["pointTransferArray"] = js_point_transfer_buffer;
}

void TransferPoint(Napi::Env env, const TSPoint &point) {
  auto *data = env.GetInstanceData<AddonData>();
  data->point_transfer_buffer[0] = point.row;
  data->point_transfer_buffer[1] = point.column / 2;
}

Napi::Object RangeToJS(Napi::Env env, const TSRange &range) {
  Object result = Object::New(env);
  result.Set("startPosition", PointToJS(env, range.start_point));
  result.Set("startIndex", ByteCountToJS(env, range.start_byte));
  result.Set("endPosition", PointToJS(env, range.end_point));
  result.Set("endIndex", ByteCountToJS(env, range.end_byte));
  return result;
}

Napi::Maybe<TSRange> RangeFromJS(const Napi::Value& arg) {
  Env env = arg.Env();
  if (!arg.IsObject()) {
    TypeError::New(env, "Range must be a {startPosition, endPosition, startIndex, endIndex} object").ThrowAsJavaScriptException();
    return Napi::Nothing<TSRange>();
  }

  TSRange result;

  auto js_range = arg.As<Object>();

  #define INIT(field, key, Convert) { \
    auto value = js_range.Get(key); \
    if (value.IsEmpty()) { \
      TypeError::New(env, "Range must be a {startPosition, endPosition, startIndex, endIndex} object").ThrowAsJavaScriptException(); \
      return Napi::Nothing<TSRange>(); \
    } \
    auto field = Convert(value); \
    if (field.IsJust()) { \
      result.field = field.Unwrap(); \
    } else { \
      return Napi::Nothing<TSRange>(); \
    } \
  }

  auto range_point = [](const Napi::Value &point) { return PointFromJS(point, false); };
  INIT(start_point, "startPosition", range_point);
  INIT(end_point, "endPosition", range_point);
  INIT(start_byte, "startIndex", ByteCountFromJS);
  INIT(end_byte, "endIndex", ByteCountFromJS);

  #undef INIT

  if (result.start_byte > result.end_byte || result.start_point.row > result.end_point.row ||
      (result.start_point.row == result.end_point.row && result.start_point.column > result.end_point.column)) {
    throw RangeError::New(env, "Range endpoints must be ordered");
  }
  return Napi::Just(result);
}

Napi::Object PointToJS(Napi::Env env, const TSPoint &point) {
  Object result = Object::New(env);
  result["row"] = Number::New(env, point.row);
  result["column"] = ByteCountToJS(env, point.column);
  return result;
}

Napi::Maybe<TSPoint> PointFromJS(const Napi::Value& arg, bool allow_infinity) {
  Env env = arg.Env();

  if (!arg.IsObject()) {
    TypeError::New(env, "Point must be a {row, column} object").ThrowAsJavaScriptException();
    return Napi::Nothing<TSPoint>();
  }
  auto js_point = arg.As<Object>();

  const uint32_t row = UnsignedInteger(js_point.Get("row"), UINT32_MAX, "Point.row", allow_infinity);
  const uint32_t character_column = UnsignedInteger(js_point.Get("column"), UINT32_MAX / 2, "Point.column", allow_infinity);
  const uint32_t column = character_column == UINT32_MAX ? UINT32_MAX : character_column * BYTES_PER_CHARACTER;

  return Napi::Just<TSPoint>({row, column});
}

Napi::Number ByteCountToJS(Napi::Env env, uint32_t byte_count) {
  return Number::New(env, byte_count / BYTES_PER_CHARACTER);
}

Napi::Maybe<uint32_t> ByteCountFromJS(const Napi::Value &arg) {
  Napi::Env env = arg.Env();

  if (!arg.IsNumber()) {
    TypeError::New(env, "Character index must be a number").ThrowAsJavaScriptException();
    return Napi::Nothing<uint32_t>();
  }
  return Napi::Just<uint32_t>(UnsignedInteger(arg, UINT32_MAX / 2, "Character index") * BYTES_PER_CHARACTER);
}

} // namespace node_tree_sitter

// Keep upstream sources unchanged; MSVC's C mode needs the C11 spelling.
#if defined(_MSC_VER) && !defined(__cplusplus)
#define static_assert _Static_assert
#endif
#include "../vendor/tree-sitter/lib/src/lib.c"

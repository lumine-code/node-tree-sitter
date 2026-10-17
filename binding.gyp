{
  "targets": [
    {
      "target_name": "tree_sitter_runtime_binding",
      "dependencies": [
          "tree_sitter",
          "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
      ],
      "sources": [
        "src/binding.cc",
        "src/conversions.cc",
        "src/language.cc",
        "src/logger.cc",
        "src/lookaheaditerator.cc",
        "src/node.cc",
        "src/parser.cc",
        "src/query.cc",
        "src/tree.cc",
        "src/tree_cursor.cc",
        "src/wasm.cc",
      ],
      "include_dirs": [
        "vendor/tree-sitter/lib/include",
        "<!(node script/wasmtime-path.js include)",
      ],
      "libraries": ["<!(node script/wasmtime-path.js library)"],
      "defines": [
        "NAPI_VERSION=<(napi_build_version)",
        "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS",
        "LIBWASM_STATIC",
      ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_SYMBOLS_PRIVATE_EXTERN": "YES", # -fvisibility=hidden
            "CLANG_CXX_LANGUAGE_STANDARD": "<(cxxstd)",
            "MACOSX_DEPLOYMENT_TARGET": "10.9",
          },
        }],
        ["OS=='win'", {
          "libraries": ["ws2_32.lib", "advapi32.lib", "userenv.lib", "ntdll.lib", "ole32.lib", "bcrypt.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": [
                "/std:<(cxxstd)",
              ],
              "RuntimeLibrary": 0,
            },
          },
        }],
        ["OS == 'linux'", {
          "libraries": ["-lpthread", "-ldl", "-lm"],
          "cflags_cc": [
            "-std=<(cxxstd)",
            "-fvisibility=hidden",
            "-Wno-cast-function-type",
          ]
        }],
      ]
    },
    {
      "target_name": "tree_sitter",
      "type": "static_library",
      "sources": [
        "src/runtime.c"
      ],
      "include_dirs": [
        "vendor/tree-sitter/lib/src",
        "vendor/tree-sitter/lib/include",
        "<!(node script/wasmtime-path.js include)",
      ],
      "defines": [
        "_POSIX_C_SOURCE=200112L",
        "_DEFAULT_SOURCE",
        "TREE_SITTER_FEATURE_WASM",
        "LIBWASM_STATIC",
      ],
      "conditions": [
        ["OS!='win'", {
          "cflags_c": [
            "-std=c11",
          ],
        }, { # OS == "win"
          "msvs_settings": {"VCCLCompilerTool": {"AdditionalOptions!": ["-std:c++20", "/std:c++20"], "AdditionalOptions": ["/std:c11"], "LanguageStandard_C": "stdc11"}},
          "cflags_c": [
            "/std:c11",
          ],
        }],
      ],
    }
  ],
  "variables": {
    "runtime%": "node",
    "openssl_fips": "",
    "v8_enable_pointer_compression%": 0,
    "v8_enable_31bit_smis_on_64bit_arch%": 0,
    "cxxstd%": "<!(node -p \"parseInt(process.env.npm_config_target ?? process.versions.node) < 22 ? 'c++17' : 'c++20'\")",
  }
}

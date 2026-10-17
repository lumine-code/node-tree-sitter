module.exports = [
  {
    files: [
      "index.js",
      "background-parser.js",
      "text-edits.js",
      "test/review_test.js",
      "test/lifecycle_test.js",
      "test/predicates_test.js",
      "test/final_review_test.js",
      "script/**/*.js",
      "test/wasm_test.js",
      "test/api_test.js",
      "benchmark/**/*.js",
    ],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    rules: {
      "no-unreachable": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-constant-condition": "error",
    },
  },
];

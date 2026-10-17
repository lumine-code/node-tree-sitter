module.exports = [
  {
    files: ["background-parser.js", "script/**/*.js", "test/wasm_test.js", "benchmark/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    rules: {
      "no-unreachable": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-constant-condition": "error",
    },
  },
];

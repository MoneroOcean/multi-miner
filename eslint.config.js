"use strict";
const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  { ignores: ["node_modules/**", "dist/**", ".cache/**", "coverage/**", "test-artifacts/**", ".nyc_output/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" }],
      "no-throw-literal": "error",
      "default-case-last": "error",
      "no-unused-expressions": "error",
      "no-var": "error",
      "no-else-return": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "always", { "null": "ignore" }],
      "no-implicit-coercion": "error",
      "object-shorthand": "error",
      "prefer-template": "error",
      "no-shadow": "error",
      "no-param-reassign": "error"
    }
  }
];

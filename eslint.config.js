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
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" }]
    }
  }
];

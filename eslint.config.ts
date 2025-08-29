import eslint from "@eslint/js";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/coverage/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "unused-imports": unusedImports,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "unused-imports/no-unused-imports": "warn",
      "simple-import-sort/imports": "warn",
      "simple-import-sort/exports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "no-constant-condition": "off",
      "prefer-const": "warn",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  }
);

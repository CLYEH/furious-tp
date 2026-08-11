import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      // A rejection that is not an Error is a real thing upstream code does,
      // and the degradation path has to survive it. Tests are where that gets
      // reproduced, so the rule that forbids writing one belongs off here and
      // nowhere else.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
    },
  },
);

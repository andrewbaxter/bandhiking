module.exports = {
  env: {
    browser: true,
    es6: true
  },
  extends: [
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "tsconfig.json",
    sourceType: "module"
  },
  plugins: ["@typescript-eslint"],
  rules: {
    "@typescript-eslint/array-type": "off",
    "@typescript-eslint/no-empty-function": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-parameter-properties": "off",
    "@typescript-eslint/no-use-before-define": "off",
    "@typescript-eslint/prefer-for-of": "error",
    "@typescript-eslint/prefer-function-type": "error",
    "@typescript-eslint/unified-signatures": "error",
    camelcase: "error",
    complexity: "off",
    "constructor-super": "error",
    "dot-notation": "error",
    eqeqeq: ["error"],
    "guard-for-in": "error",
    "id-match": "error",
    "max-classes-per-file": "off",
    "new-parens": "error",
    "@typescript-eslint/no-this-alias": "off",
    "@typescript-eslint/no-misused-promises": "error",
    "no-bitwise": "error",
    "no-caller": "error",
    "no-cond-assign": "error",
    "no-console": "off",
    "no-debugger": "error",
    "no-empty": "off",
    "no-eval": "error",
    "no-fallthrough": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-invalid-this": "off",
    "no-new-wrappers": "error",
    "no-redeclare": "error",
    "no-shadow": [
      "off",
      {
        builtinGlobals: true,
        hoist: "all"
      }
    ],
    "no-throw-literal": "error",
    "no-trailing-spaces": "error",
    "no-undef-init": "error",
    "no-underscore-dangle": "off",
    "@typescript-eslint/no-array-constructor": "off",
    "no-unsafe-finally": "error",
    "no-unused-expressions": "error",
    "no-unused-labels": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "object-shorthand": "off",
    "one-var": ["error", "never"],
    radix: "error",
    "spaced-comment": "error",
    "use-isnan": "error",
    "valid-typeof": "off",
    "@typescript-eslint/require-await": "off"
  }
};

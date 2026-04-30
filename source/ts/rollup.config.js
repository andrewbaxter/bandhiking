import resolve from "@rollup/plugin-node-resolve";

export default {
  input: "src/mobile.js",
  output: {
    dir: "../static",
    format: "iife"
  },
  plugins: [resolve()]
};

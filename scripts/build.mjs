import { build } from "esbuild";
const common = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "eof",
};
await build({ ...common, format: "esm", outfile: "dist/clickman.js" });
await build({
  ...common,
  format: "iife",
  globalName: "Clickman",
  outfile: "dist/clickman.global.js",
});

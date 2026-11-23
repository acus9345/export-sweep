import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { lex, parseJsonc, parseModule, readPathConfig, sweep } from "../dist/index.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "export-sweep-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const names = (src: string, jsx = false) => parseModule(src, jsx).exports.map((e) => `${e.kind === "type" ? "type " : ""}${e.name}${e.from ? `<-${e.from.source}#${e.from.name}` : ""}`);

describe("parseModule", () => {
  it("reads every kind of export", () => {
    const src = `
      export const a = 1, b = [1, 2], { c, d: renamed, e = 5, ...rest } = obj, [f, , g = 1] = arr
      export let h: Record<string, number> = {}
      export function fn() {}
      export async function* gen() {}
      export default class {}
      export class K {}
      export abstract class Abs {}
      export enum E { A }
      export const enum CE { A }
      export declare const declared: string
      export namespace NS {}
      export interface I {}
      export type T = string
      export { local1, local2 as alias2 }
      export type { TypeOnly }
      export { x, y as z } from "./other"
      export * from "./star"
      export * as ns from "./ns"
    `;
    assert.deepEqual(names(src), [
      "a", "b", "c", "renamed", "e", "rest", "f", "g", "h", "fn", "gen", "default", "K", "Abs", "E", "CE", "declared", "NS",
      "type I", "type T", "local1", "alias2", "type TypeOnly", "x<-./other#x", "z<-./other#y", "ns<-./ns#*",
    ]);
    assert.deepEqual(parseModule(src, false).starExports, ["./star"]);
  });

  it("reads every kind of import", () => {
    const src = `
      import def from "./a"
      import { b, c as cc, type D } from "./b"
      import * as ns from "./c"
      import type { T } from "./d"
      import def2, { e } from "./e"
      import "./side-effect"
      import x = require("./f")
      const lazy = await import("./g")
      const cjs = require("./h")
      import.meta.url
      obj.import("./not-a-module")
    `;
    assert.deepEqual(
      parseModule(src, false).imports.map((i) => `${i.source}:${i.names.join(",")}${i.typeOnly ? ":type" : ""}`),
      ["./a:default", "./b:b,c,D", "./c:*", "./d:T:type", "./e:default,e", "./side-effect:", "./f:*", "./g:*", "./h:*"],
    );
  });

  it("isn't fooled by strings, comments, templates, regexes and JSX", () => {
    const src = `
      const s = "export const fake = 1";
      // export const commented = 1
      /* import x from "./nope" */
      const t = \`export const inTemplate = \${import("./real-dynamic")} \${"}"}\`;
      const r = /export const inRegex = "/g;
      const ratio = a / b / c;
      export const Comp = () => <div title="it's fine" data-x={\`a\${1}\`}>don't {count > 1 ? <b>many</b> : "one"} <>frag</></div>;
      export const generic = <T,>(v: T) => v;
      export const after = 1;
    `;
    const info = parseModule(src, true);
    assert.deepEqual(info.exports.map((e) => e.name), ["Comp", "generic", "after"]);
    assert.deepEqual(info.imports.map((i) => i.source), ["./real-dynamic"]);
  });

  it("knows which exports are used inside their own file", () => {
    const info = parseModule("export const a = 1; export const b = a + 1; export function c() { return obj.b } const o = { c: 1 }", false);
    assert.deepEqual([...info.usedLocally], ["a"]);

    const multi = parseModule("export default function def() {}\nexport const x = 1, y = 2;\nconst local = 1;\nexport { local as aliased };", false);
    assert.deepEqual([...multi.usedLocally], []);

    const aliasedUsed = parseModule("const x = 1; export { x as y }; console.log(x);", false);
    assert.deepEqual([...aliasedUsed.usedLocally], ["y"]);

    const defaultUsed = parseModule("export default function helper() {}; helper();", false);
    assert.deepEqual([...defaultUsed.usedLocally], ["default"]);

    const defaultClassUsed = parseModule("export default class Helper {} new Helper();", false);
    assert.deepEqual([...defaultClassUsed.usedLocally], ["default"]);

    const defaultIdentUsed = parseModule("const helper = 1; export default helper; console.log(helper);", false);
    assert.deepEqual([...defaultIdentUsed.usedLocally], ["default"]);

    const defaultParenUsed = parseModule("const helper = () => 1; export default (helper); helper();", false);
    assert.deepEqual([...defaultParenUsed.usedLocally], ["default"]);

    const defaultParenUnused = parseModule("const helper = () => 1; export default (helper);", false);
    assert.deepEqual([...defaultParenUnused.usedLocally], []);

    const defaultAsyncIdentUsed = parseModule("const async = () => 1; export default async; async();", false);
    assert.deepEqual([...defaultAsyncIdentUsed.usedLocally], ["default"]);

    const defaultAsyncIdentUnused = parseModule("const async = () => 1; export default async;", false);
    assert.deepEqual([...defaultAsyncIdentUnused.usedLocally], []);
  });

  it("handles deeply nested generic declarators and multi-line ignore comments", () => {
    const src = `
      export const m: Map<string, Map<string, Array<number>>> = new Map(), next = 1;
      /**
       * Used dynamically.
       * export-sweep-ignore
       */
      export function kept() {}
    `;
    const info = parseModule(src, false);
    assert.deepEqual(info.exports.map((e) => e.name), ["m", "next", "kept"]);
    const kept = info.exports.find((e) => e.name === "kept")!;
    assert.ok(info.ignoredLines.has(kept.line));

    assert.deepEqual(parseModule("export const x = foo<A, B>(), y = 1;", false).exports.map((e) => e.name), ["x", "y"]);
    assert.deepEqual(parseModule("export const a = x < y, b = 1;", false).exports.map((e) => e.name), ["a", "b"]);
    assert.deepEqual(parseModule("export const a = x < y, b = (z) > (1);", false).exports.map((e) => e.name), ["a", "b"]);
    assert.deepEqual(parseModule("export const first = <T = unknown, U = unknown>(x: T) => x, last = 1;", false).exports.map((e) => e.name), ["first", "last"]);
  });

  it("tracks lines and columns", () => {
    const [t] = lex("\n  foo", false).tokens;
    assert.deepEqual([t!.line, t!.col], [2, 3]);
  });
});

describe("sweep", () => {
  it("finds unused exports and files across a project", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "app", main: "dist/index.js", exports: { "./cli": "./dist/cli.js" } }),
      "tsconfig.json": `{ // comments are fine
        "compilerOptions": { "rootDir": "src", "outDir": "dist", "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },
      }`,
      "src/index.ts": `export { format } from "./format.js"; export * from "./star"; import { used } from "@/util"; console.log(used());`,
      "src/cli.ts": `import * as all from "./everything"; console.log(all);`,
      "src/format.ts": `export function format() {} export function formatUnused() {}`,
      "src/star.ts": `export const fromStar = 1;`,
      "src/util.ts": `export function used() { return helper() } export function helper() { return 1 } export const unused = 2; export type Unused = string;`,
      "src/everything.ts": `export const one = 1; export const two = 2;`,
      "src/lazy.ts": `export default function lazy() {}`,
      "src/router.ts": `export const routes = [() => import("./lazy")];`,
      "src/orphan.ts": `export const orphan = 1;`,
      "src/ignored.ts": `// export-sweep-ignore-file\nexport const kept = 1;`,
      "test/util.test.ts": `import { helper } from "../src/util"; helper();`,
    });
    const r = sweep({ root });
    assert.deepEqual(
      r.unusedExports.map((u) => `${u.file}:${u.name}${u.usedInFile ? "(local)" : ""}`),
      ["src/format.ts:formatUnused", "src/util.ts:unused", "src/util.ts:Unused"],
    );
    // router.ts imports lazy.ts dynamically, but nothing imports router.ts itself.
    assert.deepEqual(r.unusedFiles, ["src/orphan.ts", "src/router.ts"]);
    assert.ok(r.entries.includes("src/index.ts") && r.entries.includes("src/cli.ts"));
    assert.deepEqual(sweep({ root, types: false }).unusedExports.filter((u) => u.kind === "type"), []);
  });

  it("follows re-export chains and namespace imports", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "lib", exports: "./src/index.ts" }),
      "src/index.ts": `export { a } from "./barrel"; import { viaStar } from "./barrel"; console.log(viaStar)`,
      "src/barrel.ts": `export { a, b } from "./impl"; export * from "./more";`,
      "src/impl.ts": `export const a = 1; export const b = 2;`,
      "src/more.ts": `export const viaStar = 1; export const notUsed = 2;`,
    });
    assert.deepEqual(
      sweep({ root }).unusedExports.map((u) => `${u.file}:${u.name}${u.reexport ? "(re-export)" : ""}`),
      ["src/barrel.ts:b(re-export)", "src/impl.ts:b", "src/more.ts:notUsed"],
    );
  });

  it("maps test imports of built files back to sources, and honours --entry and ignore comments", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x" }),
      "src/index.ts": `export const api = 1;`,
      "src/extra.ts": `// export-sweep-ignore\nexport const keepMe = 1;\nexport const dropMe = 2;`,
      "test/a.test.mjs": `import { api } from "../dist/index.js"; import "../dist/extra.js";`,
    });
    const r = sweep({ root, entries: [] });
    assert.deepEqual(r.unusedExports.map((u) => u.name), ["dropMe"]);
    assert.deepEqual(sweep({ root, entries: ["src/extra.ts"] }).unusedExports, []);
    assert.deepEqual(sweep({ root, entries: ["src\\extra.ts"] }).unusedExports, []);
  });

  it("does not mark default exports as used through export * barrels", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "lib", exports: "./src/index.ts" }),
      "src/index.ts": `export * from "./sub"; export * as ns from "./ns";`,
      "src/sub.ts": `export const named = 1; export default function unusedDefault() {}`,
      "src/ns.ts": `export default function usedViaNs() {}`,
    });
    const r = sweep({ root });
    assert.deepEqual(r.unusedExports.map((u) => `${u.file}:${u.name}:${u.usedInFile}`), ["src/sub.ts:default:false"]);
  });

  it("parses JSONC with BOM and string commas, and keeps paths without baseUrl scoped", () => {
    assert.deepEqual(parseJsonc('\uFEFF{ "a": "keep, }", "b": [1, ], }'), { a: "keep, }", b: [1] });
    const root = project({
      "package.json": JSON.stringify({ name: "app", main: "src/index.ts" }),
      "tsconfig.json": '\uFEFF{ "compilerOptions": { "paths": { "@/*": ["./src/*"], }, }, }',
      "src/index.ts": `import { ok } from "@/util"; import "bare"; console.log(ok);`,
      "src/util.ts": `export const ok = 1;`,
      "bare.ts": `export const shouldBeUnused = 1;`,
    });
    const cfg = readPathConfig(root);
    assert.equal(cfg.baseUrl, undefined);
    const r = sweep({ root });
    assert.deepEqual(r.unusedExports, []);
    assert.deepEqual(r.unusedFiles, ["bare.ts"]);
  });

  it("preserves usedInFile for aliased local exports and locally used named default functions", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "app", main: "index.ts" }),
      "index.ts": `import "./sub"; import "./def"; import "./paren"; import "./async-ident";`,
      "sub.ts": `const x = 1; export { x as y }; console.log(x);`,
      "def.ts": `export default function helper() {}; helper();`,
      "paren.ts": `const helper = () => 1; export default (helper); helper();`,
      "async-ident.ts": `const async = () => 1; export default async; async();`,
    });
    const r = sweep({ root });
    assert.deepEqual(
      r.unusedExports.map((u) => `${u.file}:${u.name}:${u.usedInFile}`),
      ["async-ident.ts:default:true", "def.ts:default:true", "paren.ts:default:true", "sub.ts:y:true"],
    );
    const cli = spawnSync(process.execPath, [CLI, root], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /async-ident\.ts\n {2}1:24 {4}default {2}used in this file only: drop the export keyword/);
    assert.match(cli.stdout, /def\.ts\n {2}1:1 {5}default {2}used in this file only: drop the export keyword/);
    assert.match(cli.stdout, /paren\.ts\n {2}1:25 {4}default {2}used in this file only: drop the export keyword/);
    assert.match(cli.stdout, /y\s+used in this file only: drop the export keyword/);
  });

  it("resolves package.json #imports subpath specifiers", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "app", main: "index.ts", imports: { "#foo": "./sub.ts", "#x/*": "./src/*.ts" } }),
      "index.ts": `import { used } from "#foo"; import { special } from "#x/$&"; console.log(used, special);`,
      "sub.ts": `export const used = 1;`,
      "src/$&.ts": `export const special = 2;`,
    });
    const r = sweep({ root });
    assert.deepEqual(r.unusedExports, []);
    assert.deepEqual(r.unusedFiles, []);
  });
});

describe("cli", () => {
  it("prints findings grouped by file and exits 1", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x", main: "src/index.ts" }),
      "src/index.ts": `import { a } from "./lib"; console.log(a);`,
      "src/lib.ts": `export const a = 1;\nexport const b = 2;\nexport function c() {}\nc();`,
    });
    const r = spawnSync(process.execPath, [CLI, root], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^src\/lib\.ts\n {2}2:14 {4}b\n {2}3:17 {4}c {2}used in this file only: drop the export keyword\n\n2 unused exports and 0 unused files in 2 files\./);
    const json = JSON.parse(spawnSync(process.execPath, [CLI, root, "--json", "--no-fail"], { encoding: "utf8" }).stdout);
    assert.equal(json.unusedExports.length, 2);
    assert.equal(spawnSync(process.execPath, [CLI, root, "--no-fail"]).status, 0);
    assert.equal(spawnSync(process.execPath, [CLI, join(root, "nope")]).status, 2);
  });
});

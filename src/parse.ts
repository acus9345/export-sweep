import { lex, type Token } from "./lexer.js";

/** An import of another module. */
export interface ImportRecord {
  source: string;
  /** Names imported: export name → used. `*` means everything (namespace, dynamic import, require). */
  names: string[];
  typeOnly: boolean;
  line: number;
}

/** An export of this module. */
export interface ExportRecord {
  /** Exported name; `default` for default exports. */
  name: string;
  kind: "value" | "type";
  line: number;
  col: number;
  /** For re-exports: the module and the name there (`*` for `export * as ns`). */
  from?: { source: string; name: string };
}

export interface ModuleInfo {
  imports: ImportRecord[];
  exports: ExportRecord[];
  /** `export * from "x"` sources. */
  starExports: string[];
  /** Uses `export =` or CommonJS `module.exports`: exports can't be tracked by name. */
  commonjs: boolean;
  /** Export names that are also used inside the file itself. */
  usedLocally: Set<string>;
  /** Lines with an `export-sweep-ignore` comment (applies to that line and the next). */
  ignoredLines: Set<number>;
  /** The whole file has `export-sweep-ignore-file`. */
  ignoreFile: boolean;
}

const DECL_KEYWORDS = new Set(["function", "class", "const", "let", "var", "interface", "type", "enum", "namespace", "module", "using"]);
const STATEMENT_START = new Set(["export", "import", "const", "let", "var", "function", "class", "interface", "type", "enum", "declare", "namespace", "abstract", "if", "for", "while", "do", "switch", "try", "return", "throw"]);

/** Parse one module's imports and exports. */
export function parseModule(source: string, jsx: boolean): ModuleInfo {
  const { tokens, comments } = lex(source, jsx);
  const info: ModuleInfo = {
    imports: [],
    exports: [],
    starExports: [],
    commonjs: false,
    usedLocally: new Set(),
    ignoredLines: new Set(),
    ignoreFile: false,
  };
  for (const c of comments) {
    if (/\bexport-sweep-ignore-file\b/.test(c.text)) info.ignoreFile = true;
    else if (/\bexport-sweep-ignore\b/.test(c.text)) {
      info.ignoredLines.add(c.line);
      info.ignoredLines.add(c.line + 1);
    }
  }

  const importBindings = new Map<string, { source: string; name: string }>();
  const exportSpecifierTokens = new Set<number>();
  let depth = 0;
  const at = (k: number): Token | undefined => tokens[k];
  const is = (k: number, value: string, type?: Token["type"]) => {
    const t = tokens[k];
    return t !== undefined && t.value === value && (type === undefined || t.type === type) && (t.type === "ident" || t.type === "punct" || type === "string");
  };

  /** Skip a balanced region starting at an opening bracket. Returns the index after the closer. */
  const skipBalanced = (k: number): number => {
    let d = 0;
    for (let j = k; j < tokens.length; j++) {
      const v = tokens[j]!;
      if (v.type !== "punct") continue;
      if (v.value === "{" || v.value === "(" || v.value === "[" || v.value === "${") d++;
      else if (v.value === "}" || v.value === ")" || v.value === "]") {
        d--;
        if (d === 0) return j + 1;
      }
    }
    return tokens.length;
  };

  /** Parse `{ a, b as c, type d }`. Returns specifiers and the index after `}`. */
  const specifiers = (k: number): { list: { name: string; alias: string; typeOnly: boolean; tokenIndex: number }[]; next: number } => {
    const list: { name: string; alias: string; typeOnly: boolean; tokenIndex: number }[] = [];
    let j = k + 1;
    while (j < tokens.length && !is(j, "}")) {
      let typeOnly = false;
      if (is(j, "type") && at(j + 1) !== undefined && !is(j + 1, ",") && !is(j + 1, "}") && !is(j + 1, "as")) {
        typeOnly = true;
        j++;
      }
      const t = at(j);
      if (t === undefined) break;
      const name = t.value;
      const tokenIndex = j;
      let alias = name;
      j++;
      if (is(j, "as")) {
        alias = at(j + 1)?.value ?? name;
        j += 2;
      }
      list.push({ name, alias, typeOnly, tokenIndex });
      if (is(j, ",")) j++;
    }
    return { list, next: j + 1 };
  };

  /** Binding names in a destructuring pattern starting at `{` or `[`. Returns names and index after the pattern. */
  const patternNames = (k: number): { names: Token[]; next: number } => {
    const end = skipBalanced(k);
    const names: Token[] = [];
    // Depth of brackets opened inside a default value; while > 0 or right after `=`, nothing is a binding.
    let inDefault = false;
    let defaultDepth = 0;
    for (let j = k + 1; j < end - 1; j++) {
      const t = tokens[j]!;
      if (t.type === "punct") {
        if (inDefault) {
          if (t.value === "{" || t.value === "[" || t.value === "(" || t.value === "${") defaultDepth++;
          else if (t.value === "}" || t.value === "]" || t.value === ")") defaultDepth--;
          else if (t.value === "," && defaultDepth === 0) inDefault = false;
          if (defaultDepth < 0) {
            inDefault = false;
            defaultDepth = 0;
          }
        } else if (t.value === "=") {
          inDefault = true;
          defaultDepth = 0;
        }
        continue;
      }
      if (inDefault || t.type !== "ident") continue;
      // `{ key: binding }`: the key isn't a binding.
      const next = tokens[j + 1];
      if (next?.type === "punct" && next.value === ":") continue;
      names.push(t);
    }
    return { names, next: end };
  };

  /** Skip a variable initializer: to the next top-level `,` (returns true) or the end of the statement. */
  const skipInitializer = (k: number): { next: number; more: boolean } => {
    let d = 0;
    // Until the `=`, we're in a type annotation, where `<...>` brackets hold commas: `Record<K, V>`.
    let inType = true;
    for (let j = k; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type === "punct") {
        if (inType && d === 0 && t.value === "=") inType = false;
        if (inType && t.value === "<") d++;
        else if (inType && t.value === ">" && d > 0) d--;
        else if (inType && t.value === ">>" && d > 1) d -= 2;
        else if (t.value === "{" || t.value === "(" || t.value === "[" || t.value === "${") d++;
        else if (t.value === "}" || t.value === ")" || t.value === "]") {
          if (d === 0) return { next: j, more: false };
          d--;
        } else if (d === 0 && t.value === ",") return { next: j + 1, more: true };
        else if (d === 0 && t.value === ";") return { next: j + 1, more: false };
      } else if (d === 0 && t.type === "ident" && STATEMENT_START.has(t.value) && j > k && tokens[j - 1]!.line < t.line) {
        const prev = tokens[j - 1]!;
        // A new line that starts a statement ends the initializer (no semicolons style).
        if (!(prev.type === "punct" && /^(?:=|=>|\(|,|\?|:|&&|\|\||\?\?|\+|-|\*|\/|\.|\?\.)$/.test(prev.value))) return { next: j, more: false };
      }
    }
    return { next: tokens.length, more: false };
  };

  const addExport = (name: string, kind: "value" | "type", t: Token, from?: { source: string; name: string }) => {
    if (info.exports.some((e) => e.name === name && e.kind === kind && e.from === undefined && from === undefined)) return;
    info.exports.push({ name, kind, line: t.line, col: t.col, ...(from ? { from } : {}) });
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "${") depth++;
      else if (t.value === "}") depth--;
      continue;
    }
    if (t.type !== "ident") continue;
    const prev = tokens[k - 1];
    const afterDot = prev?.type === "punct" && (prev.value === "." || prev.value === "?.");

    // Dynamic import() and require() anywhere.
    if (!afterDot && (t.value === "import" || t.value === "require") && is(k + 1, "(") && at(k + 2)?.type === "string") {
      const close = at(k + 3);
      if (close?.type === "punct" && (close.value === ")" || close.value === ",")) {
        info.imports.push({ source: at(k + 2)!.value, names: ["*"], typeOnly: false, line: t.line });
      }
      continue;
    }
    // CommonJS exports.
    if (!afterDot && t.value === "module" && is(k + 1, ".") && is(k + 2, "exports")) info.commonjs = true;
    if (!afterDot && t.value === "exports" && is(k + 1, ".") && depth === 0) info.commonjs = true;

    if (depth !== 0 || afterDot) continue;

    if (t.value === "import" && !is(k + 1, "(") && !is(k + 1, ".")) {
      let j = k + 1;
      let typeOnly = false;
      if (is(j, "type") && !is(j + 1, "from") && !is(j + 1, ",") && !is(j + 1, "=")) {
        typeOnly = true;
        j++;
      }
      // import "side-effect"
      if (at(j)?.type === "string") {
        info.imports.push({ source: at(j)!.value, names: [], typeOnly, line: t.line });
        continue;
      }
      // import x = require("y")
      if (at(j)?.type === "ident" && is(j + 1, "=")) {
        if (is(j + 2, "require") && at(j + 4)?.type === "string") {
          info.imports.push({ source: at(j + 4)!.value, names: ["*"], typeOnly, line: t.line });
          k = j + 4; // don't count the require() again
        }
        continue;
      }
      const names: string[] = [];
      const bindings: { local: string; name: string }[] = [];
      while (j < tokens.length && !is(j, "from")) {
        const u = at(j)!;
        if (u.type === "ident" && !is(j, ",")) {
          if (u.value === "type" && at(j + 1)?.type === "ident" && !is(j + 1, "from")) {
            j++;
            continue;
          }
          names.push("default");
          bindings.push({ local: u.value, name: "default" });
          j++;
        } else if (is(j, "*")) {
          names.push("*");
          j += 3; // * as ns
        } else if (is(j, "{")) {
          const { list, next } = specifiers(j);
          for (const s of list) {
            names.push(s.name);
            bindings.push({ local: s.alias, name: s.name });
          }
          j = next;
        } else j++;
        if (j - k > 400) break;
      }
      const src = at(j + 1);
      if (is(j, "from") && src?.type === "string") {
        info.imports.push({ source: src.value, names, typeOnly, line: t.line });
        for (const b of bindings) importBindings.set(b.local, { source: src.value, name: b.name });
        k = j + 1;
      }
      continue;
    }

    if (t.value !== "export") continue;
    let j = k + 1;
    const next = at(j);
    if (next === undefined) continue;

    // export = foo / export as namespace Foo
    if (is(j, "=")) {
      info.commonjs = true;
      continue;
    }
    if (is(j, "as") && is(j + 1, "namespace")) continue;

    // export default ...
    if (is(j, "default")) {
      addExport("default", "value", t);
      continue;
    }

    // export * from "x" / export * as ns from "x" / export type * from "x"
    let typeStar = false;
    if (is(j, "type") && is(j + 1, "*")) {
      typeStar = true;
      j++;
    }
    if (is(j, "*")) {
      if (is(j + 1, "as")) {
        const ns = at(j + 2)!;
        if (is(j + 3, "from") && at(j + 4)?.type === "string") {
          addExport(ns.value, typeStar ? "type" : "value", ns, { source: at(j + 4)!.value, name: "*" });
          info.imports.push({ source: at(j + 4)!.value, names: [], typeOnly: typeStar, line: t.line });
        }
      } else if (is(j + 1, "from") && at(j + 2)?.type === "string") {
        info.starExports.push(at(j + 2)!.value);
        info.imports.push({ source: at(j + 2)!.value, names: [], typeOnly: typeStar, line: t.line });
      }
      continue;
    }

    // export { a, b as c } [from "x"] / export type { ... }
    let typeList = false;
    if (is(j, "type") && is(j + 1, "{")) {
      typeList = true;
      j++;
    }
    if (is(j, "{")) {
      const { list, next: after } = specifiers(j);
      const from = is(after, "from") && at(after + 1)?.type === "string" ? at(after + 1)!.value : undefined;
      for (const s of list) {
        const tok = at(s.tokenIndex)!;
        exportSpecifierTokens.add(s.tokenIndex);
        const kind = typeList || s.typeOnly ? "type" : "value";
        if (from !== undefined) addExport(s.alias, kind, tok, { source: from, name: s.name });
        else {
          const imported = importBindings.get(s.name);
          addExport(s.alias, kind, tok, imported);
        }
      }
      if (from !== undefined) info.imports.push({ source: from, names: [], typeOnly: typeList, line: t.line });
      continue;
    }

    // export [declare] [abstract] [async] function|class|enum|interface|type|namespace|const ...
    while (is(j, "declare") || is(j, "abstract") || is(j, "async") || is(j, "default")) j++;
    const kw = at(j)?.value;
    if (kw === "import") {
      // export import A = B.C
      const name = at(j + 1);
      if (name?.type === "ident") addExport(name.value, "value", name);
      continue;
    }
    if (kw === "function" || kw === "class") {
      let n = j + 1;
      if (is(n, "*")) n++;
      const name = at(n);
      if (name?.type === "ident") addExport(name.value, "value", name);
      continue;
    }
    if (kw === "enum" || (kw === "const" && is(j + 1, "enum"))) {
      const name = at(kw === "enum" ? j + 1 : j + 2);
      if (name?.type === "ident") addExport(name.value, "value", name);
      continue;
    }
    if (kw === "namespace" || kw === "module") {
      const name = at(j + 1);
      if (name?.type === "ident") addExport(name.value, "value", name);
      continue;
    }
    if (kw === "interface") {
      const name = at(j + 1);
      if (name?.type === "ident") addExport(name.value, "type", name);
      continue;
    }
    if (kw === "type") {
      const name = at(j + 1);
      if (name?.type === "ident") addExport(name.value, "type", name);
      continue;
    }
    if (kw === "const" || kw === "let" || kw === "var" || kw === "using") {
      let n = j + 1;
      for (;;) {
        const head = at(n);
        if (head === undefined) break;
        if (head.type === "ident") {
          addExport(head.value, "value", head);
          n++;
        } else if (is(n, "{") || is(n, "[")) {
          const { names, next: after } = patternNames(n);
          for (const nm of names) addExport(nm.value, "value", nm);
          n = after;
        } else break;
        // Skip `: Type` and `= value` up to the next declarator.
        // The main loop still walks the initializer, so dynamic imports inside it are seen.
        const { next: after, more } = skipInitializer(n);
        if (!more) break;
        n = after;
      }
    }
  }

  // Which exports are also referenced inside the file (beyond their own declaration)?
  const exported = new Set(info.exports.filter((e) => e.from === undefined).map((e) => e.name));
  if (exported.size > 0) {
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.type !== "ident" || !exported.has(t.value) || exportSpecifierTokens.has(k)) continue;
      const prev = tokens[k - 1];
      const next = tokens[k + 1];
      if (prev?.type === "punct" && (prev.value === "." || prev.value === "?.")) continue;
      if (prev?.type === "ident" && DECL_KEYWORDS.has(prev.value)) continue;
      if (prev?.type === "punct" && prev.value === "*" && tokens[k - 2]?.value === "function") continue;
      // Object keys (`{ name: 1 }`) and destructured declarations are not uses.
      if (next?.type === "punct" && next.value === ":" && prev?.type === "punct" && (prev.value === "{" || prev.value === ",")) continue;
      if (isDeclaredInPattern(tokens, k)) continue;
      info.usedLocally.add(t.value);
    }
  }
  return info;
}

/** Is the identifier at `k` a binding inside `export const { ... } =` / `[ ... ] =`? */
function isDeclaredInPattern(tokens: readonly Token[], k: number): boolean {
  let d = 0;
  for (let j = k - 1; j >= 0 && k - j < 200; j--) {
    const t = tokens[j]!;
    if (t.type !== "punct") continue;
    if (t.value === "}" || t.value === "]") d++;
    else if (t.value === "{" || t.value === "[") {
      if (d === 0) {
        const before = tokens[j - 1];
        return before?.type === "ident" && (before.value === "const" || before.value === "let" || before.value === "var");
      }
      d--;
    } else if (t.value === ";") return false;
  }
  return false;
}

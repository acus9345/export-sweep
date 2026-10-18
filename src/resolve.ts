import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Parse JSON with comments and trailing commas (tsconfig style). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The parts of tsconfig that matter for resolving imports. */
export interface PathConfig {
  /** Absolute folder `paths` are relative to. */
  baseUrl: string | undefined;
  paths: Record<string, string[]>;
  rootDir: string | undefined;
  outDir: string | undefined;
}

/** Read tsconfig.json (or jsconfig.json), following `extends`. */
export function readPathConfig(root: string, file?: string): PathConfig {
  const config: PathConfig = { baseUrl: undefined, paths: {}, rootDir: undefined, outDir: undefined };
  const start = file ? resolve(root, file) : [join(root, "tsconfig.json"), join(root, "jsconfig.json")].find((p) => existsSync(p));
  if (start === undefined) return config;
  const seen = new Set<string>();
  const load = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    let json: { extends?: string | string[]; compilerOptions?: Record<string, unknown> };
    try {
      json = parseJsonc(readFileSync(path, "utf8")) as typeof json;
    } catch {
      return;
    }
    const dir = dirname(path);
    // Parents first, so this file's settings win.
    for (const ext of [json.extends ?? []].flat()) {
      const candidates = ext.startsWith(".") || ext.startsWith("/") ? [resolve(dir, ext), resolve(dir, `${ext}.json`)] : [join(root, "node_modules", ext), join(root, "node_modules", `${ext}.json`), join(root, "node_modules", ext, "tsconfig.json")];
      const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
      if (found) load(found);
    }
    const o = json.compilerOptions ?? {};
    if (typeof o.baseUrl === "string") config.baseUrl = resolve(dir, o.baseUrl);
    if (o.paths && typeof o.paths === "object") {
      // `paths` without baseUrl are relative to the config that declares them.
      config.baseUrl ??= dir;
      config.paths = { ...(o.paths as Record<string, string[]>) };
    }
    if (typeof o.rootDir === "string") config.rootDir = resolve(dir, o.rootDir);
    if (typeof o.outDir === "string") config.outDir = resolve(dir, o.outDir);
  };
  load(start);
  return config;
}

/** Find the source file an import points at, or undefined for packages and unresolvable paths. */
export class Resolver {
  readonly #root: string;
  readonly #config: PathConfig;
  readonly #imports: Record<string, unknown> | undefined;
  readonly #files: ReadonlySet<string>;

  constructor(root: string, files: ReadonlySet<string>, config: PathConfig) {
    this.#root = root;
    this.#config = config;
    this.#files = files;
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { imports?: Record<string, unknown> };
      this.#imports = pkg.imports;
    } catch {
      this.#imports = undefined;
    }
  }

  resolve(specifier: string, fromFile: string): string | undefined {
    const clean = specifier.replace(/[?#].*$/, "");
    if (clean.startsWith(".") || clean.startsWith("/")) return this.#file(resolve(dirname(fromFile), clean));
    if (clean.startsWith("#") && this.#imports) {
      for (const target of matchMap(this.#imports, clean)) {
        const found = this.#file(resolve(this.#root, target));
        if (found) return found;
      }
    }
    for (const [pattern, targets] of Object.entries(this.#config.paths)) {
      const star = matchPattern(pattern, clean);
      if (star === undefined) continue;
      for (const target of targets) {
        const found = this.#file(resolve(this.#config.baseUrl ?? this.#root, target.replace("*", star)));
        if (found) return found;
      }
    }
    if (this.#config.baseUrl && !clean.startsWith("@") && !this.#isPackageName(clean)) {
      return this.#file(resolve(this.#config.baseUrl, clean));
    }
    return undefined;
  }

  #isPackageName(spec: string): boolean {
    const name = spec.split("/")[0]!;
    return existsSync(join(this.#root, "node_modules", name));
  }

  /** Try the path itself, TS sources for compiled extensions, added extensions, and index files. */
  #file(base: string): string | undefined {
    const found = this.#candidate(base);
    if (found !== undefined) return found;
    // `../dist/index.js` (common in tests that run the build): look for the source it was built from.
    const outDirs = [this.#config.outDir, ...["dist", "lib", "build", "out"].map((d) => join(this.#root, d))];
    for (const out of outDirs) {
      if (out === undefined || !base.startsWith(out + sep)) continue;
      const inner = relative(out, base);
      for (const src of [this.#config.rootDir, join(this.#root, "src"), this.#root]) {
        const mapped = src === undefined ? undefined : this.#candidate(join(src, inner.replace(/\.d\.([cm]?)ts$/, ".$1js")));
        if (mapped !== undefined) return mapped;
      }
    }
    return undefined;
  }

  #candidate(base: string): string | undefined {
    const candidates: string[] = [base];
    const swaps: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
    for (const [ext, replacements] of Object.entries(swaps)) {
      if (base.endsWith(ext)) for (const r of replacements) candidates.push(base.slice(0, -ext.length) + r);
    }
    for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
    return candidates.find((c) => this.#files.has(c));
  }
}

/** `@app/*` against `@app/utils/x` → `utils/x`; exact patterns give "". */
function matchPattern(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === spec ? "" : undefined;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
    return spec.slice(pre.length, spec.length - post.length);
  }
  return undefined;
}

/** Targets for a package.json `imports` / `exports` map entry, conditions flattened. */
function matchMap(map: Record<string, unknown>, spec: string): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const star = matchPattern(key, spec);
    if (star === undefined) continue;
    for (const target of flattenTargets(value)) out.push(target.replace("*", star));
  }
  return out;
}

/** Every string target in an exports/imports value, preferring source-like conditions. */
export function flattenTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenTargets);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const preferred = ["source", "development", "types", "import", "default", "require", "node"];
    entries.sort(([a], [b]) => (preferred.indexOf(a) + 100) % 100 - ((preferred.indexOf(b) + 100) % 100));
    return entries.flatMap(([, v]) => flattenTargets(v));
  }
  return [];
}

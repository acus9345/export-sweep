import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { matchesAny } from "./glob.js";
import { parseModule, type ModuleInfo } from "./parse.js";
import { flattenTargets, readPathConfig, Resolver, SOURCE_EXTENSIONS } from "./resolve.js";

export interface SweepOptions {
  /** Project folder. Default `process.cwd()`. */
  root?: string;
  /** Extra entry files or globs (relative to root). Their exports count as used. */
  entries?: readonly string[];
  /** Globs of files to leave out entirely. */
  ignore?: readonly string[];
  /** Path to tsconfig.json for `paths` aliases. Default: tsconfig.json or jsconfig.json in root. */
  tsconfig?: string;
  /** Report unused type exports (interfaces, type aliases). Default `true`. */
  types?: boolean;
  /** Treat tests, configs, scripts, stories, and route files of frameworks you depend on, as entries. Default `true`. */
  conventions?: boolean;
}

export interface UnusedExport {
  /** File path relative to root, with `/` separators. */
  file: string;
  name: string;
  kind: "value" | "type";
  line: number;
  col: number;
  /** The export is used inside its own file, so only the `export` keyword is unneeded. */
  usedInFile: boolean;
  /** It re-exports another module's export. */
  reexport: boolean;
}

export interface SweepResult {
  unusedExports: UnusedExport[];
  /** Files nothing imports and that aren't entries. */
  unusedFiles: string[];
  /** Entry files found, relative to root. */
  entries: string[];
  /** Number of source files scanned. */
  files: number;
}

/** Folders never scanned. */
export const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".vercel", ".astro", "vendor", ".cache", "storybook-static"];

/** Files whose exports are used by tools rather than imports: tests, configs, scripts, stories. */
export const CONVENTIONAL_ENTRIES = [
  "**/*.{test,spec}.*", "**/__tests__/**", "test/**", "tests/**", "e2e/**", "**/*.e2e.*", "**/__mocks__/**", "**/fixtures/**",
  "**/*.config.*", "**/.*rc.*", "scripts/**", "**/*.stories.*", "**/*.story.*",
  "**/*.worker.*", "**/sw.*", "**/service-worker.*",
];

/** Route and convention files of frameworks, used when the framework is a dependency. */
export const FRAMEWORK_ENTRIES: Record<string, readonly string[]> = {
  next: [
    "{src/,}pages/**",
    "{src/,}app/**/{page,layout,route,loading,error,global-error,not-found,template,default,head,opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}.*",
    "{src/,}middleware.*",
    "{src/,}instrumentation*.*",
  ],
  "@remix-run/react": ["app/routes/**", "app/root.*", "app/entry.*"],
  "react-router": ["app/routes/**", "app/root.*", "app/entry.*", "app/routes.*"],
  "@sveltejs/kit": ["src/routes/**", "src/hooks*.*", "src/params/**"],
  astro: ["src/pages/**", "src/content/config.*", "src/middleware.*", "src/actions/**"],
  nuxt: ["pages/**", "server/**", "plugins/**", "middleware/**", "layouts/**", "composables/**", "utils/**", "app.*", "error.*"],
  "expo-router": ["app/**"],
  "@tanstack/react-start": ["src/routes/**", "app/routes/**"],
  vitepress: [".vitepress/**"],
};

/** Framework entry globs for the dependencies in package.json. */
export function frameworkEntries(root: string): string[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return [];
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.entries(FRAMEWORK_ENTRIES).flatMap(([name, globs]) => (name in deps ? globs : []));
}

/** Find exports nothing imports, and files nothing uses. */
export function sweep(options: SweepOptions = {}): SweepResult {
  const root = resolve(options.root ?? ".");
  const ignore = options.ignore ?? [];
  const all = listFiles(root).filter((f) => !matchesAny(f, ignore));
  const abs = new Map(all.map((f) => [resolve(root, f), f]));
  const fileSet = new Set(abs.keys());
  const config = readPathConfig(root, options.tsconfig);
  const resolver = new Resolver(root, fileSet, config);

  const modules = new Map<string, ModuleInfo>();
  for (const file of fileSet) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const ext = extname(file);
    // JSX is allowed in .js too (Create React App and friends).
    modules.set(file, parseModule(text, ext === ".tsx" || ext === ".jsx" || ext === ".js" || ext === ".mjs"));
  }

  // Entries: package.json fields, --entry, conventions.
  const entries = new Set<string>();
  for (const e of packageEntries(root)) {
    const found = sourceFor(e, root, fileSet, config);
    if (found) entries.add(found);
  }
  const entryGlobs = [...(options.entries ?? []), ...(options.conventions === false ? [] : [...CONVENTIONAL_ENTRIES, ...frameworkEntries(root)])];
  for (const [path, rel] of abs) if (matchesAny(rel, entryGlobs)) entries.add(path);
  if ([...entries].every((e) => matchesAny(abs.get(e) ?? "", CONVENTIONAL_ENTRIES))) {
    // No real entry point found: fall back to the usual names.
    for (const guess of ["src/index", "index", "src/main", "main", "src/cli", "cli", "src/app", "app", "src/server", "server"]) {
      for (const ext of SOURCE_EXTENSIONS) if (fileSet.has(resolve(root, guess + ext))) entries.add(resolve(root, guess + ext));
    }
  }

  const used = new Map<string, Set<string>>();
  const allUsed = new Set<string>();
  const incoming = new Set<string>();
  const target = (source: string, from: string) => resolver.resolve(source, from);

  const markAll = (file: string): void => {
    if (allUsed.has(file)) return;
    allUsed.add(file);
    const mod = modules.get(file);
    if (!mod) return;
    for (const e of mod.exports) markUsed(file, e.name);
    for (const s of mod.starExports) {
      const t = target(s, file);
      if (t) markAll(t);
    }
  };
  const markUsed = (file: string, name: string): void => {
    if (name === "*") return markAll(file);
    const set = used.get(file) ?? new Set<string>();
    if (set.has(name)) return;
    set.add(name);
    used.set(file, set);
    const mod = modules.get(file);
    if (!mod) return;
    const own = mod.exports.filter((e) => e.name === name);
    for (const e of own) {
      if (!e.from) continue;
      const t = target(e.from.source, file);
      if (t) markUsed(t, e.from.name);
    }
    if (own.length === 0 && name !== "default") {
      for (const s of mod.starExports) {
        const t = target(s, file);
        if (t) markUsed(t, name);
      }
    }
  };

  for (const [file, mod] of modules) {
    for (const imp of mod.imports) {
      const t = target(imp.source, file);
      if (!t || t === file) continue;
      incoming.add(t);
      for (const name of imp.names) markUsed(t, name);
    }
  }
  for (const e of entries) markAll(e);

  const unusedExports: UnusedExport[] = [];
  const unusedFiles: string[] = [];
  for (const [file, mod] of modules) {
    const rel = abs.get(file)!;
    if (entries.has(file) || mod.ignoreFile) continue;
    if (!incoming.has(file)) {
      unusedFiles.push(rel);
      continue;
    }
    if (mod.commonjs || allUsed.has(file)) continue;
    const names = used.get(file) ?? new Set<string>();
    for (const e of mod.exports) {
      if (names.has(e.name) || mod.ignoredLines.has(e.line)) continue;
      if (e.kind === "type" && options.types === false) continue;
      unusedExports.push({
        file: rel,
        name: e.name,
        kind: e.kind,
        line: e.line,
        col: e.col,
        usedInFile: mod.usedLocally.has(e.name),
        reexport: e.from !== undefined,
      });
    }
  }
  unusedExports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  unusedFiles.sort();
  return {
    unusedExports,
    unusedFiles,
    entries: [...entries].map((e) => abs.get(e)!).sort(),
    files: modules.size,
  };
}

/** Source files under root, relative with `/`. Uses git when available, so .gitignore applies. */
export function listFiles(root: string): string[] {
  const isSource = (f: string) =>
    SOURCE_EXTENSIONS.includes(extname(f)) && !/\.d\.[cm]?ts$/.test(f) && !f.split("/").some((part) => IGNORED_DIRS.includes(part));
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (git.status === 0 && typeof git.stdout === "string") {
    return git.stdout.split("\0").filter((f) => f !== "" && isSource(f) && existsSync(join(root, f)));
  }
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.includes(e.name)) walk(join(dir, e.name), r);
      } else if (isSource(r)) out.push(r);
    }
  };
  walk(root, "");
  return out;
}

/** Paths package.json points at: main, module, browser, types, bin, exports. */
export function packageEntries(root: string): string[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const key of ["main", "module", "browser", "types", "typings", "source"]) if (typeof pkg[key] === "string") out.push(pkg[key] as string);
  if (typeof pkg.bin === "string") out.push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === "object") out.push(...Object.values(pkg.bin as Record<string, string>).filter((v) => typeof v === "string"));
  if (pkg.exports !== undefined) out.push(...flattenTargets(pkg.exports).filter((t) => !t.includes("*")));
  return out;
}

/** Map a package.json path (often in dist/) to the source file it's built from. */
function sourceFor(path: string, root: string, files: ReadonlySet<string>, config: { rootDir: string | undefined; outDir: string | undefined }): string | undefined {
  const full = resolve(root, path);
  const candidates: string[] = [full];
  const outDirs = [config.outDir, ...["dist", "lib", "build", "out", "esm", "cjs", "dist/esm", "dist/cjs", "dist/src"].map((d) => resolve(root, d))].filter((d): d is string => d !== undefined);
  for (const out of outDirs) {
    if (!(full + sep).startsWith(out + sep) && !full.startsWith(out + sep)) continue;
    const inner = relative(out, full);
    for (const base of [config.rootDir, resolve(root, "src"), root]) if (base) candidates.push(join(base, inner));
  }
  const expanded: string[] = [];
  for (const c of candidates) {
    const noDts = c.replace(/\.d\.([cm]?)ts$/, ".$1js");
    const stem = noDts.replace(/\.[cm]?[jt]sx?$/, "");
    expanded.push(c, noDts, ...SOURCE_EXTENSIONS.map((e) => stem + e));
  }
  return expanded.find((c) => files.has(c));
}


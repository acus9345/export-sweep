# export-sweep

Find exports nobody imports in TypeScript and JavaScript projects, plus files nothing uses. Zero dependencies.

[![npm](https://img.shields.io/npm/v/export-sweep)](https://www.npmjs.com/package/export-sweep)
[![CI](https://github.com/acus9345/export-sweep/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/export-sweep/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/export-sweep)](LICENSE)

Code gets refactored, callers move, and exported helpers stay behind with nothing using them. TypeScript won't tell you, because an export always counts as used. `export-sweep` reads the whole project and lists them:

```
src/utils/format.ts
  12:17   formatBytes
  40:13   Locale       type

src/api/client.ts
  88:17   retryDelay   used in this file only: drop the export keyword

2 files are not imported by anything:
  src/legacy/old-parser.ts
  src/components/Banner.tsx

3 unused exports and 2 unused files in 214 files.
```

- **Follows real imports:** named, default, namespace, `import type`, `export ... from` chains, `export *` barrels, dynamic `import()`, `require()`, and `import x = require()`.
- **Resolves like your tools:** relative paths, `.js` → `.ts` ESM imports, tsconfig `paths` and `baseUrl` (with `extends`), and package.json `#imports`. Tests that import `../dist/...` are mapped back to `src/`.
- **Knows your entry points:** package.json `main`, `module`, `exports`, `bin` and `types` (mapped from `dist/` back to the source), plus tests, config files, scripts, stories, and the route files of Next.js, Remix, React Router, SvelteKit, Astro, Nuxt and Expo Router when you use them.
- **Any TypeScript version.** It has its own small parser, so it doesn't depend on the TypeScript compiler API (which TypeScript 7 doesn't have). JSX, generics, template literals and regexes are handled.
- **Fast:** around 25 MB of source per second.

## Install

```bash
npm install --save-dev export-sweep
```

## Usage

```bash
npx export-sweep              # the current project
npx export-sweep packages/web # another folder
```

Exit code `1` when something is unused, so it can gate CI. `--no-fail` always exits `0`.

Each finding says why it's there:

- **Plain:** nothing imports it. Delete it, or ask whether it's dead code.
- **`used in this file only: drop the export keyword`:** the code is used, just not from outside. Removing `export` is enough.
- **`type`:** an unused interface or type alias. `--no-types` hides these.
- **`re-export`:** an `export { x } from "./y"` that nothing imports through.

Files that nothing imports are listed separately (`--no-files` hides them). A file loaded only by a tool or a convention the scanner doesn't know about shows up here. Add it with `--entry`.

## Options

| Option | What it does |
| --- | --- |
| `-e, --entry <glob>` | Extra entry points, whose exports are public. Repeatable: `--entry "src/plugins/*.ts"`. |
| `-i, --ignore <glob>` | Files to leave out entirely. Repeatable. |
| `-p, --tsconfig <file>` | tsconfig to read path aliases from. Default `tsconfig.json`, then `jsconfig.json`. |
| `--no-types` | Don't report unused types and interfaces. |
| `--no-files` | Don't report unused files. |
| `--no-conventions` | Don't treat tests, configs, scripts and framework route files as entries. |
| `--json` | Machine-readable output. |
| `--no-fail` | Exit `0` even when something is unused. |

### Keeping something on purpose

```ts
// export-sweep-ignore
export function usedByAPlugin() {}
```

The comment covers the export on the next line (or the same line). `// export-sweep-ignore-file` anywhere in a file skips the whole file.

## What counts as used

An export is used when something imports it by name, imports the whole module (`import * as`, `import()`, `require()`), or reaches it through a chain of re-exports from a file that does. Exports of entry points are always used, because they're your public API.

Things it can't see:

- Imports built from strings at runtime, like `` import(`./locales/${lang}.ts`) ``. The target files show as unused; list them with `--entry`.
- Usage from other packages in a monorepo. Run it per package, and pass the files other packages import with `--entry`.
- Exports used only through a framework's naming convention it doesn't know. Add those files with `--entry`.

Plain `.js` files that use CommonJS (`module.exports`) are followed as imports but their exports aren't reported.

## In CI

```yaml
- run: npx export-sweep --no-types
```

## Library

```js
import { sweep } from "export-sweep";

const { unusedExports, unusedFiles, entries } = sweep({ root: ".", entries: ["src/plugins/*.ts"] });
```

Also exported: `parseModule` (imports and exports of one file), `lex`, `listFiles`, `readPathConfig`, `Resolver`.

## License

MIT

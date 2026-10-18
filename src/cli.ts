#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sweep, type UnusedExport } from "./analyze.js";

const HELP = `export-sweep - find exports nobody imports

Usage:
  export-sweep [folder] [options]

Scans the TypeScript and JavaScript files in a project (respecting .gitignore),
follows imports, re-exports, path aliases and dynamic imports, and lists exports
that nothing imports and files that nothing uses. Exports of entry points
(package.json main/exports/bin, tests, configs, framework routes) count as used.

Options:
  -e, --entry <glob>     Extra entry files whose exports are public. Repeatable.
  -i, --ignore <glob>    Files to leave out. Repeatable.
  -p, --tsconfig <file>  tsconfig for path aliases. Default: tsconfig.json or jsconfig.json
      --no-types         Don't report unused types and interfaces.
      --no-files         Don't report unused files.
      --no-conventions   Don't treat tests, configs and framework routes as entries.
      --json             Print the result as JSON.
      --no-fail          Exit 0 even when something is unused.
  -h, --help             Show this help.
  -v, --version          Show the version number.

Ignore one export with a comment on the line above it:  // export-sweep-ignore
Ignore a whole file:                                     // export-sweep-ignore-file

Exit codes: 0 nothing unused, 1 something unused, 2 bad usage.

Examples:
  export-sweep
  export-sweep packages/app --entry "src/plugins/*.ts"
  export-sweep --no-types --json > unused.json
`;

class UsageError extends Error {}

const useColor = process.stdout.isTTY === true && !("NO_COLOR" in process.env);
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function run(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        entry: { type: "string", short: "e", multiple: true },
        ignore: { type: "string", short: "i", multiple: true },
        tsconfig: { type: "string", short: "p" },
        types: { type: "boolean", default: true },
        files: { type: "boolean", default: true },
        conventions: { type: "boolean", default: true },
        json: { type: "boolean" },
        fail: { type: "boolean", default: true },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError("pass one project folder.");
  const root = resolve(positionals[0] ?? ".");
  if (!existsSync(root)) throw new UsageError(`can't find folder "${positionals[0]}".`);

  const result = sweep({
    root,
    entries: values.entry ?? [],
    ignore: values.ignore ?? [],
    ...(values.tsconfig === undefined ? {} : { tsconfig: values.tsconfig }),
    types: values.types,
    conventions: values.conventions,
  });
  const files = values.files ? result.unusedFiles : [];
  const count = result.unusedExports.length + files.length;

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...result, unusedFiles: files }, null, 2)}\n`);
    return count > 0 && values.fail ? 1 : 0;
  }
  if (result.files === 0) {
    process.stdout.write(`No TypeScript or JavaScript files found in ${root}.\n`);
    return 0;
  }

  const lines: string[] = [];
  const byFile = new Map<string, UnusedExport[]>();
  for (const u of result.unusedExports) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
  for (const [file, list] of byFile) {
    lines.push(bold(file));
    const width = Math.max(...list.map((u) => u.name.length));
    for (const u of list) {
      const where = `${u.line}:${u.col}`.padEnd(8);
      const notes = [u.kind === "type" ? "type" : "", u.reexport ? "re-export" : "", u.usedInFile ? "used in this file only: drop the export keyword" : ""].filter(Boolean).join(", ");
      lines.push(`  ${dim(where)}${u.name}${notes ? `${" ".repeat(width - u.name.length + 2)}${dim(notes)}` : ""}`);
    }
    lines.push("");
  }
  if (files.length > 0) {
    lines.push(bold(`${files.length} ${files.length === 1 ? "file is" : "files are"} not imported by anything:`));
    for (const f of files) lines.push(`  ${f}`);
    lines.push("");
  }
  const summary =
    count === 0
      ? `No unused exports in ${result.files} files.`
      : `${result.unusedExports.length} unused ${result.unusedExports.length === 1 ? "export" : "exports"}${values.files ? ` and ${files.length} unused ${files.length === 1 ? "file" : "files"}` : ""} in ${result.files} files.`;
  lines.push(summary);
  if (count > 0) lines.push(dim(`Entry points: ${result.entries.length === 0 ? "none found (pass --entry)" : result.entries.slice(0, 5).join(", ") + (result.entries.length > 5 ? `, +${result.entries.length - 5} more` : "")}`));
  process.stdout.write(`${lines.join("\n")}\n`);
  return count > 0 && values.fail ? 1 : 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`export-sweep: ${error.message}\nRun "export-sweep --help" for usage.\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}

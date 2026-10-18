/**
 * Find exports nobody imports, and files nothing uses.
 *
 * @example
 * import { sweep } from "export-sweep";
 *
 * const { unusedExports, unusedFiles } = sweep({ root: "." });
 */
export { CONVENTIONAL_ENTRIES, FRAMEWORK_ENTRIES, frameworkEntries, IGNORED_DIRS, listFiles, packageEntries, sweep } from "./analyze.js";
export type { SweepOptions, SweepResult, UnusedExport } from "./analyze.js";
export { lex } from "./lexer.js";
export type { Lexed, Token, TokenType } from "./lexer.js";
export { parseModule } from "./parse.js";
export type { ExportRecord, ImportRecord, ModuleInfo } from "./parse.js";
export { parseJsonc, readPathConfig, Resolver } from "./resolve.js";
export type { PathConfig } from "./resolve.js";

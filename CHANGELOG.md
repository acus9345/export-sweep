# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-18

### Added

- `export-sweep` CLI and `sweep()` API: lists exports nothing imports and files nothing uses, grouped by file, with line and column.
- Notes for exports only used in their own file, type-only exports and unused re-exports.
- Follows named, default, namespace, type-only, dynamic and CommonJS imports, `export ... from` chains and `export *` barrels.
- Resolves relative paths, `.js` to `.ts` ESM imports, tsconfig `paths`/`baseUrl` with `extends`, package.json `#imports`, and `dist/` paths back to `src/`.
- Entry points from package.json (`main`, `module`, `exports`, `bin`, `types`), tests, configs, scripts, stories, and the route files of Next.js, Remix, React Router, SvelteKit, Astro, Nuxt and Expo Router when they are dependencies.
- Its own JS/TS/JSX tokenizer, so it works with any TypeScript version, including 7.
- `--entry`, `--ignore`, `--tsconfig`, `--no-types`, `--no-files`, `--no-conventions`, `--json`, `--no-fail`, and `export-sweep-ignore` comments.

[0.1.0]: https://github.com/acus9345/export-sweep/releases/tag/v0.1.0

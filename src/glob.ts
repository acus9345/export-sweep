/**
 * Small glob matcher (`**`, `*`, `?`, `[...]`, `{a,b}`) for relative POSIX
 * paths. A pattern without a slash matches the file name at any depth.
 */

const cache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;
  let pattern = glob.trim().replace(/^\.\//, "");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  else if (!pattern.includes("/")) pattern = `**/${pattern}`;
  if (pattern.endsWith("/")) pattern += "**";
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const slashAfter = pattern[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (ch === "{") {
      braces++;
      re += "(?:";
    } else if (ch === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (ch === "," && braces > 0) re += "|";
    else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

/** Does the path match any glob? A leading `!` excludes (later entries win). */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  let matched = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (globToRegExp(glob.slice(1)).test(normalized)) matched = false;
    } else if (globToRegExp(glob).test(normalized)) matched = true;
  }
  return matched;
}

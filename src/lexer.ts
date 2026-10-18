/**
 * A small JavaScript/TypeScript tokenizer. It only needs to be right about
 * what matters for imports and exports: identifiers, punctuation and string
 * literals, while skipping comments, template text, regular expressions and
 * JSX text without getting lost. Code inside `${...}` and JSX `{...}` is
 * tokenized like any other code.
 */

export type TokenType = "ident" | "string" | "punct" | "number" | "template" | "regex";

export interface Token {
  type: TokenType;
  /** Identifier name, punctuation, or a string's value (without quotes). */
  value: string;
  /** Offset in the source. */
  start: number;
  line: number;
  col: number;
}

export interface Lexed {
  tokens: Token[];
  /** Comments with the line they start on, for ignore directives. */
  comments: { text: string; line: number }[];
}

const PUNCT3 = ["...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??="];
const PUNCT2 = ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
// After these keywords an expression starts, so `/` is a regex and `<` may be JSX.
const EXPR_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends", "default"]);

const isIdStart = (c: string | undefined) => c !== undefined && /[\p{ID_Start}$_]/u.test(c);
const isIdPart = (c: string | undefined) => c !== undefined && /[\p{ID_Continue}$‌‍]/u.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

class Lexer {
  readonly tokens: Token[] = [];
  readonly comments: { text: string; line: number }[] = [];
  i = 0;
  #lineStarts: number[] = [0];

  readonly src: string;
  readonly jsx: boolean;

  constructor(src: string, jsx: boolean) {
    this.src = src;
    this.jsx = jsx;
    for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) this.#lineStarts.push(k + 1);
  }

  position(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.#lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.#lineStarts[lo]! + 1 };
  }

  push(type: TokenType, value: string, start: number): void {
    this.tokens.push({ type, value, start, ...this.position(start) });
  }

  exprAllowed(): boolean {
    const prev = this.tokens.at(-1);
    if (prev === undefined) return true;
    if (prev.type === "punct") return !(prev.value === ")" || prev.value === "]" || prev.value === "jsx");
    if (prev.type === "ident") return EXPR_KEYWORDS.has(prev.value);
    return false;
  }

  readString(quote: string): string {
    let value = "";
    this.i++;
    while (this.i < this.src.length && this.src[this.i] !== quote) {
      const c = this.src[this.i]!;
      if (c === "\\") {
        const next = this.src[this.i + 1] ?? "";
        value += next === "n" ? "\n" : next === "t" ? "\t" : next === "\n" || next === "\r" ? "" : next;
        this.i += 2;
        continue;
      }
      if (c === "\n") break; // unterminated string: stop at the line end
      value += c;
      this.i++;
    }
    this.i++;
    return value;
  }

  /** From inside a template, skip text up to the next `${` (returns true) or the closing backtick. */
  templateText(): boolean {
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      if (c === "`") {
        this.i++;
        return false;
      }
      if (c === "$" && this.src[this.i + 1] === "{") {
        this.i += 2;
        return true;
      }
      this.i++;
    }
    return false;
  }

  template(): void {
    const start = this.i;
    this.i++;
    this.push("template", "`", start);
    while (this.templateText()) {
      this.push("punct", "${", this.i - 2);
      this.scan(true);
      this.push("punct", "}", this.i);
      this.i++; // the closing brace
    }
  }

  regex(): void {
    const start = this.i;
    this.i++;
    let inClass = false;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      if (c === "\n") break;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        this.i++;
        break;
      }
      this.i++;
    }
    while (isIdPart(this.src[this.i])) this.i++;
    this.push("regex", this.src.slice(start, this.i), start);
  }

  /** `{ expression }` inside JSX. `i` is at the `{`. */
  jsxExpression(): boolean {
    this.i++;
    this.scan(true);
    if (this.src[this.i] !== "}") return false;
    this.i++;
    return true;
  }

  /** One JSX tag. `i` is at `<`. */
  jsxTag(): "open" | "close" | "self" | undefined {
    const src = this.src;
    this.i++;
    while (isSpace(src[this.i])) this.i++;
    const closing = src[this.i] === "/";
    if (closing) this.i++;
    while (isSpace(src[this.i])) this.i++;
    if (src[this.i] === ">") {
      this.i++;
      return closing ? "close" : "open"; // fragment
    }
    if (!isIdStart(src[this.i])) return undefined;
    while (isIdPart(src[this.i]) || src[this.i] === "." || src[this.i] === ":" || src[this.i] === "-") this.i++;
    for (;;) {
      while (isSpace(src[this.i])) this.i++;
      const c = src[this.i];
      if (c === undefined) return undefined;
      if (c === ">") {
        this.i++;
        return closing ? "close" : "open";
      }
      if (c === "/" && src[this.i + 1] === ">") {
        this.i += 2;
        return "self";
      }
      if (closing) return undefined;
      if (c === "{") {
        if (!this.jsxExpression()) return undefined; // {...spread}
        continue;
      }
      if (!isIdStart(c)) return undefined;
      while (isIdPart(src[this.i]) || src[this.i] === "-" || src[this.i] === ":") this.i++;
      while (src[this.i] === " " || src[this.i] === "\t") this.i++;
      if (src[this.i] !== "=") continue;
      this.i++;
      while (isSpace(src[this.i])) this.i++;
      const v = src[this.i];
      if (v === '"' || v === "'") this.readString(v);
      else if (v === "{") {
        if (!this.jsxExpression()) return undefined;
      } else if (v === "<") {
        if (!this.jsxElement()) return undefined;
      } else return undefined;
    }
  }

  /** A whole JSX element. Returns false when this `<` isn't JSX after all. */
  jsxElement(): boolean {
    const kind = this.jsxTag();
    if (kind === undefined || kind === "close") return false;
    if (kind === "self") return true;
    let depth = 1;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === "{") {
        if (!this.jsxExpression()) return false;
      } else if (c === "<") {
        const k = this.jsxTag();
        if (k === undefined) return false;
        if (k === "open") depth++;
        else if (k === "close" && --depth === 0) return true;
      } else this.i++;
    }
    return false;
  }

  tryJsx(): boolean {
    const save = this.i;
    const count = this.tokens.length;
    const comments = this.comments.length;
    this.push("punct", "jsx", save);
    if (this.jsxElement()) return true;
    this.i = save;
    this.tokens.length = count;
    this.comments.length = comments;
    return false;
  }

  /** Tokenize until the end, or (when `nested`) until an unmatched `}`. */
  scan(nested: boolean): void {
    const src = this.src;
    let depth = 0;
    while (this.i < src.length) {
      const c = src[this.i]!;
      const start = this.i;
      if (isSpace(c) || c === "﻿") {
        this.i++;
        continue;
      }
      if (c === "/" && src[this.i + 1] === "/") {
        const end = src.indexOf("\n", this.i);
        const stop = end === -1 ? src.length : end;
        this.comments.push({ text: src.slice(this.i + 2, stop), line: this.position(this.i).line });
        this.i = stop;
        continue;
      }
      if (c === "/" && src[this.i + 1] === "*") {
        const end = src.indexOf("*/", this.i + 2);
        const stop = end === -1 ? src.length : end + 2;
        this.comments.push({ text: src.slice(this.i + 2, Math.max(this.i + 2, stop - 2)), line: this.position(this.i).line });
        this.i = stop;
        continue;
      }
      if (c === "#" && this.i === 0 && src[1] === "!") {
        const end = src.indexOf("\n");
        this.i = end === -1 ? src.length : end;
        continue;
      }
      if (c === "'" || c === '"') {
        this.push("string", this.readString(c), start);
        continue;
      }
      if (c === "`") {
        this.template();
        continue;
      }
      if (c === "}" && nested && depth === 0) return;
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[this.i + 1] ?? ""))) {
        this.i++;
        while (this.i < src.length && /[0-9a-zA-Z_.]/.test(src[this.i]!)) {
          if (/[eE]/.test(src[this.i]!) && /[+-]/.test(src[this.i + 1] ?? "")) this.i++;
          this.i++;
        }
        this.push("number", src.slice(start, this.i), start);
        continue;
      }
      if (isIdStart(c) || c === "\\" || (c === "#" && isIdStart(src[this.i + 1]))) {
        this.i++;
        while (isIdPart(src[this.i]) || src[this.i] === "\\") this.i++;
        this.push("ident", src.slice(start, this.i), start);
        continue;
      }
      if (c === "/" && this.exprAllowed()) {
        this.regex();
        continue;
      }
      if (c === "<" && this.jsx && this.exprAllowed() && /[A-Za-z_$>]/.test(src[this.i + 1] ?? "") && this.tryJsx()) continue;
      const three = src.slice(this.i, this.i + 3);
      const two = src.slice(this.i, this.i + 2);
      const p = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
      this.i += p.length;
      if (p === "{") depth++;
      else if (p === "}") depth--;
      this.push("punct", p, start);
    }
  }
}

/** Tokenize source. `jsx` enables JSX (for .jsx and .tsx files). */
export function lex(source: string, jsx: boolean): Lexed {
  const lexer = new Lexer(source, jsx);
  lexer.scan(false);
  return { tokens: lexer.tokens, comments: lexer.comments };
}

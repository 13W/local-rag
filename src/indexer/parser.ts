import { createRequire } from "node:module";
import { dirname, join, basename, extname } from "node:path";
import { load as loadYaml, loadAll } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import { Parser, Language } from "web-tree-sitter";
import type { CodeChunk } from "../types.js";

const require = createRequire(import.meta.url);

// ── LanguageDef interface ─────────────────────────────────────────────────────

interface LanguageDef {
  readonly language:       string;
  readonly extractNodes:   ReadonlySet<string>;
  readonly chunkTypeMap:   Readonly<Record<string, string>>;
  readonly containerNodes: ReadonlySet<string>;
  readonly extractName:    (node: SyntaxNode, parent?: SyntaxNode, grandparent?: SyntaxNode) => string;
  readonly docStyle:       "jsdoc" | "slashslash" | "none";
  readonly importNode?:    string;
}

// ── extension map ─────────────────────────────────────────────────────────────

type ExtEntry =
  | { kind: "treesitter"; wasmKey: string; defKey: string }
  | { kind: "data";       parser:  "yaml" | "toml" | "json" }
  | { kind: "text";       parser:  "markdown" | "plaintext" };

const EXT_MAP: Record<string, ExtEntry> = {
  // Existing — unchanged behaviour
  ".ts":   { kind: "treesitter", wasmKey: "typescript", defKey: "typescript" },
  ".tsx":  { kind: "treesitter", wasmKey: "tsx",        defKey: "typescript" },
  ".js":   { kind: "treesitter", wasmKey: "typescript", defKey: "typescript" },
  ".jsx":  { kind: "treesitter", wasmKey: "tsx",        defKey: "typescript" },
  ".mts":  { kind: "treesitter", wasmKey: "typescript", defKey: "typescript" },
  ".cts":  { kind: "treesitter", wasmKey: "typescript", defKey: "typescript" },
  // New tree-sitter languages
  ".rs":   { kind: "treesitter", wasmKey: "rust",       defKey: "rust" },
  ".go":   { kind: "treesitter", wasmKey: "go",         defKey: "go"  },
  // Data formats
  ".yaml": { kind: "data", parser: "yaml" },
  ".yml":  { kind: "data", parser: "yaml" },
  ".json": { kind: "data", parser: "json" },
  ".toml": { kind: "data", parser: "toml" },
  // Text formats
  ".md":   { kind: "text", parser: "markdown" },
  ".mdx":  { kind: "text", parser: "markdown" },
  ".txt":  { kind: "text", parser: "plaintext" },
};

export const EXTENSIONS = new Set(Object.keys(EXT_MAP));

// ── tree-sitter type shims ────────────────────────────────────────────────────

interface Point { row: number; column: number }

interface SyntaxNode {
  type:          string;
  text:          string;
  startPosition: Point;
  endPosition:   Point;
  children:      SyntaxNode[];
}

// ── constants ─────────────────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 3000;
const MIN_CHUNK_CHARS = 50;

// ── name extractors ───────────────────────────────────────────────────────────

const TS_EXTRACT_NODES = new Set([
  "function_declaration", "function_expression",
  "generator_function_declaration", "generator_function",
  "arrow_function", "method_definition",
  "function_signature", "class_declaration", "abstract_class_declaration", "class_expression",
  "interface_declaration", "type_alias_declaration", "enum_declaration",
  "export_statement", "lexical_declaration",
  "variable_declarator",
]);

function firstBindingFromPattern(node: SyntaxNode): string {
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "shorthand_property_identifier_pattern")
      return child.text;
    if (child.type === "object_pattern" || child.type === "array_pattern") {
      const n = firstBindingFromPattern(child);
      if (n) return n;
    }
  }
  return "";
}

/** Extract the last meaningful name from a callee expression.
 * Handles: identifier, member_expression (obj.method), call_expression (fn.each([])). */
function calleeLastName(node: SyntaxNode): string {
  if (node.type === "identifier" || node.type === "property_identifier") return node.text;
  // member_expression (app.get, describe.each) → last property_identifier/identifier
  if (node.type === "member_expression") {
    const rev = [...node.children].reverse();
    const id = rev.find((c) => c.type === "identifier" || c.type === "property_identifier");
    if (id) return id.text;
  }
  // call_expression callee: describe.each([...]) → recurse into its callee
  if (node.type === "call_expression" && node.children[0]) {
    return calleeLastName(node.children[0]);
  }
  // Generic fallback: last identifier found in any child
  const rev = [...node.children].reverse();
  for (const child of rev) {
    const name = calleeLastName(child);
    if (name) return name;
  }
  return "";
}

function extractNameIdentifier(node: SyntaxNode, parent?: SyntaxNode, grandparent?: SyntaxNode): string {
  // If an anonymous function is a class field value, name it after the field
  if (
    parent?.type === "field_definition" ||
    parent?.type === "public_field_definition"
  ) {
    const propId = parent.children.find(
      (c) => c.type === "property_identifier" || c.type === "private_property_identifier",
    );
    if (propId) return propId.text;
  }
  // Arrow/function assigned as an object literal property: { handleClick: () => {} }
  if (parent?.type === "pair") {
    const key = parent.children.find(
      (c) => c.type === "property_identifier" || c.type === "string",
    );
    if (key) return key.type === "string" ? key.text.slice(1, -1) : key.text;
  }
  // Function assigned via assignment expression: exports.foo = () => {}, this.handler = fn
  if (parent?.type === "assignment_expression") {
    const lhs = parent.children[0];
    if (lhs) {
      if (lhs.type === "identifier" || lhs.type === "property_identifier") return lhs.text;
      // member_expression (exports.foo, this.handler) → last identifier
      const rev = [...lhs.children].reverse();
      const id = rev.find((c) => c.type === "identifier" || c.type === "property_identifier");
      if (id) return id.text;
    }
  }
  // Callback passed as argument: app.get('/route', fn), new Worker(fn), describe.each([])(fn)
  if (
    parent?.type === "arguments" &&
    (grandparent?.type === "call_expression" || grandparent?.type === "new_expression")
  ) {
    const callee =
      grandparent.type === "new_expression"
        ? grandparent.children.find(
            (c) => c.type !== "new" && c.type !== "arguments" && c.type !== "type_arguments",
          )
        : grandparent.children[0];
    if (callee) {
      const name = calleeLastName(callee);
      if (name) return name;
    }
  }
  let hasDefault = false;
  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier" ||
      child.type === "private_property_identifier"
    ) {
      return child.text;
    }
    if (TS_EXTRACT_NODES.has(child.type)) {
      const name = extractNameIdentifier(child);
      if (name) return name;   // non-empty → done
      continue;                // empty → keep looking (hasDefault may still be set)
    }
    // Destructuring LHS (object/array pattern) — grab first binding; don't fall through to RHS
    if (child.type === "object_pattern" || child.type === "array_pattern")
      return firstBindingFromPattern(child);
    if (child.type === "export_clause") {
      // export { foo, bar } — use the first exported name
      for (const spec of child.children) {
        if (spec.type === "export_specifier") {
          const id = spec.children.find(
            (c) => c.type === "identifier" || c.type === "type_identifier",
          );
          if (id) return id.text;
        }
      }
    }
    if (child.type === "namespace_export") {
      // export * as ns from './foo' — use the alias, fall back to "*"
      const id = child.children.find((c) => c.type === "identifier");
      return id ? id.text : "*";
    }
    if (child.type === "*") {
      // export * from './foo'
      return "*";
    }
    if (child.type === "ambient_declaration") {
      // export declare class Foo / export declare function foo
      const name = extractNameIdentifier(child);
      if (name) return name;
    }
    if (child.type === "default") hasDefault = true;
  }
  return hasDefault ? "default" : "";
}

function extractNameField(node: SyntaxNode, _parent?: SyntaxNode, _grandparent?: SyntaxNode): string {
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "type_identifier") return child.text;
    for (const grandchild of child.children) {
      if (grandchild.type === "identifier" || grandchild.type === "type_identifier") return grandchild.text;
    }
  }
  return "";
}

// ── language definitions ──────────────────────────────────────────────────────

const TS_DEF: LanguageDef = {
  language: "typescript",
  extractNodes: TS_EXTRACT_NODES,
  chunkTypeMap: {
    function_declaration:       "function",
    arrow_function:             "function",
    method_definition:          "method",
    function_signature:         "function_signature",
    class_declaration:          "class",
    abstract_class_declaration: "class",
    interface_declaration:      "interface",
    type_alias_declaration:     "type_alias",
    enum_declaration:           "enum",
    export_statement:           "export",
    lexical_declaration:        "variable",
  },
  containerNodes: new Set(["class_declaration", "abstract_class_declaration", "interface_declaration"]),
  extractName: extractNameIdentifier,
  docStyle: "jsdoc",
  importNode: "import_statement",
};

const RUST_DEF: LanguageDef = {
  language: "rust",
  extractNodes: new Set([
    "function_item", "impl_item", "struct_item", "enum_item",
    "trait_item", "type_item", "mod_item", "static_item", "const_item",
  ]),
  chunkTypeMap: {
    function_item: "function",
    impl_item:     "class",
    struct_item:   "class",
    enum_item:     "enum",
    trait_item:    "interface",
    type_item:     "type_alias",
    mod_item:      "module",
    static_item:   "variable",
    const_item:    "variable",
  },
  containerNodes: new Set(["impl_item", "struct_item", "trait_item", "mod_item"]),
  extractName: extractNameField,
  docStyle: "slashslash",
  importNode: "use_declaration",
};

const GO_DEF: LanguageDef = {
  language: "go",
  extractNodes: new Set([
    "function_declaration", "method_declaration",
    "type_declaration", "var_declaration", "const_declaration",
  ]),
  chunkTypeMap: {
    function_declaration: "function",
    method_declaration:   "method",
    type_declaration:     "class",
    var_declaration:      "variable",
    const_declaration:    "variable",
  },
  containerNodes: new Set(["type_declaration"]),
  extractName: extractNameField,
  docStyle: "slashslash",
  importNode: "import_declaration",
};

const LANG_DEFS: Record<string, LanguageDef> = {
  typescript: TS_DEF,
  rust:       RUST_DEF,
  go:         GO_DEF,
};

// ── parser cache ──────────────────────────────────────────────────────────────

const parserCache    = new Map<string, Parser>();
let   wasmInitPromise: Promise<void> | null = null;

function resolveWasmPath(wasmKey: string): string {
  const pkg = wasmKey === "tsx" ? "tree-sitter-typescript" : `tree-sitter-${wasmKey}`;
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  return join(dir, `tree-sitter-${wasmKey}.wasm`);
}

async function getParser(wasmKey: string): Promise<Parser> {
  if (!wasmInitPromise) {
    wasmInitPromise = Parser.init({
      locateFile: (f: string) => join(dirname(require.resolve("web-tree-sitter")), f),
    });
  }
  await wasmInitPromise;
  const cached = parserCache.get(wasmKey);
  if (cached) return cached;
  const lang = await Language.load(resolveWasmPath(wasmKey));
  const p = new Parser();
  p.setLanguage(lang);
  parserCache.set(wasmKey, p);
  return p;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getSignature(node: SyntaxNode): string {
  const firstLine = node.text.split("\n")[0]!.trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

function extractJsDoc(lines: string[], nodeStartRow: number): string {
  if (nodeStartRow <= 0) return "";

  let endRow = nodeStartRow - 1;
  while (endRow >= 0 && (lines[endRow] ?? "").trim() === "") endRow--;

  const endLine = lines[endRow];
  if (endRow < 0 || !endLine || !endLine.trimEnd().endsWith("*/")) return "";

  let startRow = endRow;
  while (startRow >= 0 && !(lines[startRow] ?? "").trim().startsWith("/**")) {
    startRow--;
  }
  if (startRow < 0 || !(lines[startRow] ?? "").trim().startsWith("/**")) return "";

  return lines.slice(startRow, endRow + 1).join("\n");
}

function extractLineComments(lines: string[], nodeStartRow: number, prefix: string): string {
  let row = nodeStartRow - 1;
  while (row >= 0 && (lines[row] ?? "").trim() === "") row--;
  const collected: string[] = [];
  while (row >= 0 && (lines[row] ?? "").trim().startsWith(prefix)) {
    collected.unshift(lines[row]!);
    row--;
  }
  return collected.join("\n");
}

function extractDoc(lines: string[], row: number, style: LanguageDef["docStyle"]): string {
  if (style === "none" || row <= 0) return "";
  if (style === "jsdoc")      return extractJsDoc(lines, row);
  if (style === "slashslash") return extractLineComments(lines, row, "//");
  return "";
}

// ── import extraction ─────────────────────────────────────────────────────────

/**
 * Walk the AST root node and extract raw import source strings.
 * For TypeScript/JS: import_statement nodes contain a `string` with the module path.
 * For Rust: use_declaration nodes contain an identifier path.
 * For Go: import_declaration nodes contain interpreted_string_literal children.
 */
function extractImports(root: SyntaxNode, language: string): string[] {
  const importNode = LANG_DEFS[language]?.importNode;
  if (!importNode) return [];

  const imports: string[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === importNode) {
      const src = extractImportSource(node, language);
      if (src) imports.push(src);
      return; // don't recurse into import nodes
    }
    for (const child of node.children) walk(child);
  }
  walk(root);
  return imports;
}

function extractImportSource(node: SyntaxNode, language: string): string {
  if (language === "typescript") {
    // import_statement: import ... from "source" or export ... from "source"
    for (const child of node.children) {
      if (child.type === "string") {
        // Strip quotes
        const raw = child.text;
        return raw.slice(1, raw.length - 1);
      }
    }
  } else if (language === "rust") {
    // use_declaration: use some::path;
    // Just return the path text (first non-keyword child)
    for (const child of node.children) {
      if (child.type !== "use" && child.type !== ";") return child.text;
    }
  } else if (language === "go") {
    // import_declaration may have import_spec children with interpreted_string_literal
    for (const child of node.children) {
      if (child.type === "interpreted_string_literal") {
        const raw = child.text;
        return raw.slice(1, raw.length - 1);
      }
      for (const grandchild of child.children) {
        if (grandchild.type === "interpreted_string_literal") {
          const raw = grandchild.text;
          return raw.slice(1, raw.length - 1);
        }
      }
    }
  }
  return "";
}

// ── AST walker ────────────────────────────────────────────────────────────────

function walkTree(
  node: SyntaxNode,
  filePath: string,
  lines: string[],
  chunks: CodeChunk[],
  def: LanguageDef,
  parentKey?: string,
  parent?: SyntaxNode,
  grandparent?: SyntaxNode,
): void {
  if (def.extractNodes.has(node.type)) {
    const text = node.text;
    if (text.length < MIN_CHUNK_CHARS) return;

    const myKey = `${filePath}:${node.startPosition.row + 1}`;
    const isLargeContainer = def.containerNodes.has(node.type) && text.length > MAX_CHUNK_CHARS;

    if (isLargeContainer) {
      const chunk: CodeChunk = {
        content:   text,
        filePath,
        chunkType: def.chunkTypeMap[node.type] ?? "block",
        name:      def.extractName(node, parent, grandparent),
        signature: getSignature(node),
        startLine: node.startPosition.row + 1,
        endLine:   node.endPosition.row + 1,
        language:  def.language,
        jsdoc:     extractDoc(lines, node.startPosition.row, def.docStyle),
        chunkRole: "parent",
      };
      if (parentKey !== undefined) chunk.parentKey = parentKey;
      chunks.push(chunk);
      for (const child of node.children) walkTree(child, filePath, lines, chunks, def, myKey, node, parent);
      return;
    }

    const chunk: CodeChunk = {
      content:   text,
      filePath,
      chunkType: def.chunkTypeMap[node.type] ?? "block",
      name:      def.extractName(node, parent, grandparent),
      signature: getSignature(node),
      startLine: node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
      language:  def.language,
      jsdoc:     extractDoc(lines, node.startPosition.row, def.docStyle),
      chunkRole: parentKey !== undefined ? "child" : "regular",
    };
    if (parentKey !== undefined) chunk.parentKey = parentKey;
    chunks.push(chunk);
    return;
  }

  for (const child of node.children) walkTree(child, filePath, lines, chunks, def, parentKey, node, parent);
}

// ── data format parsers ───────────────────────────────────────────────────────

function parseJsonFile(filePath: string, source: string): CodeChunk[] {
  if (source.length > 100_000) return [];
  
  let data: unknown;
  try {
    data = loadYaml(source);
  } catch {
    // Fallback to simpler parsing if YAML parser fails
    data = null;
  }

  const stem  = basename(filePath, extname(filePath));
  const lines = source.split("\n");

  if (source.length <= MAX_CHUNK_CHARS || typeof data !== "object" || data === null || Array.isArray(data)) {
    return [{
      content:   source,
      filePath,
      chunkType: "document",
      name:      stem,
      signature: "",
      startLine: 1,
      endLine:   lines.length,
      language:  "json",
      jsdoc:     "",
    }];
  }

  const chunks: CodeChunk[] = [{
    content:   source,
    filePath,
    chunkType: "document",
    name:      stem,
    signature: "",
    startLine: 1,
    endLine:   lines.length,
    language:  "json",
    jsdoc:     "",
  }];

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const serialized = JSON.stringify(value, null, 2);
    chunks.push({
      content:   serialized,
      filePath,
      chunkType: "document",
      name:      key,
      signature: "",
      startLine: 1,
      endLine:   1,
      language:  "json",
      jsdoc:     "",
    });
  }

  return chunks;
}

function parseYaml(filePath: string, source: string): CodeChunk[] {
  const stem   = basename(filePath, extname(filePath));
  const docs: unknown[] = [];
  loadAll(source, (doc: unknown) => { docs.push(doc); });
  const chunks: CodeChunk[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (typeof doc !== "object" || doc === null) continue;
    const rec      = doc as Record<string, unknown>;
    const kind     = typeof rec["kind"] === "string" ? rec["kind"] : "document";
    const meta     = rec["metadata"];
    const metaName = (typeof meta === "object" && meta !== null)
      ? (meta as Record<string, unknown>)["name"]
      : undefined;
    const name     = typeof metaName === "string"
      ? metaName
      : (docs.length > 1 ? `${stem}-doc-${i}` : stem);

    const serialized = JSON.stringify(doc, null, 2);

    if (serialized.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        content:   serialized,
        filePath,
        chunkType: kind,
        name,
        signature: "",
        startLine: 1,
        endLine:   1,
        language:  "yaml",
        jsdoc:     "",
      });
      continue;
    }

    chunks.push({
      content:   serialized,
      filePath,
      chunkType: kind,
      name,
      signature: "",
      startLine: 1,
      endLine:   1,
      language:  "yaml",
      jsdoc:     "",
    });

    for (const [key, value] of Object.entries(rec)) {
      if (typeof value !== "object" || value === null) continue;
      const sec = JSON.stringify(value, null, 2);
      chunks.push({
        content:   sec,
        filePath,
        chunkType: kind,
        name:      `${name}/${key}`,
        signature: "",
        startLine: 1,
        endLine:   1,
        language:  "yaml",
        jsdoc:     "",
      });
    }
  }

  return chunks;
}

function parseTomlFile(filePath: string, source: string): CodeChunk[] {
  const data  = parseToml(source) as Record<string, unknown>;
  const stem  = basename(filePath, extname(filePath));
  const lines = source.split("\n");

  if (source.length <= MAX_CHUNK_CHARS) {
    return [{
      content:   source,
      filePath,
      chunkType: "document",
      name:      stem,
      signature: "",
      startLine: 1,
      endLine:   lines.length,
      language:  "toml",
      jsdoc:     "",
    }];
  }

  const chunks: CodeChunk[] = [{
    content:   source,
    filePath,
    chunkType: "document",
    name:      stem,
    signature: "",
    startLine: 1,
    endLine:   lines.length,
    language:  "toml",
    jsdoc:     "",
  }];

  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const serialized = JSON.stringify(value, null, 2);
    chunks.push({
      content:   serialized,
      filePath,
      chunkType: "table",
      name:      key,
      signature: "",
      startLine: 1,
      endLine:   1,
      language:  "toml",
      jsdoc:     "",
    });
  }

  return chunks;
}

// ── text format parsers ───────────────────────────────────────────────────────

/** Split large text into overlapping chunks at paragraph/line boundaries. */
function splitTextIntoChunks(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end < text.length) {
      // Prefer paragraph break near the end of the window
      const paraBreak = text.lastIndexOf("\n\n", end);
      if (paraBreak > start + maxChars / 2) {
        end = paraBreak;
      } else {
        // Fall back to any line break
        const lineBreak = text.lastIndexOf("\n", end);
        if (lineBreak > start + maxChars / 2) end = lineBreak;
      }
    } else {
      end = text.length;
    }

    chunks.push(text.slice(start, end).trimEnd());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

function parseMarkdown(filePath: string, source: string): CodeChunk[] {
  const stem  = basename(filePath, extname(filePath));
  const lines = source.split("\n");

  // Track heading hierarchy for breadcrumb context
  const headingStack: Array<{ level: number; title: string }> = [];

  type Section = {
    level:      number;
    title:      string;
    breadcrumb: string;
    startLine:  number;
    endLine:    number;
    content:    string;
  };

  const sections: Section[] = [];
  let sectionLines: string[] = [];
  let sectionTitle  = stem;
  let sectionLevel  = 0;
  let sectionStart  = 1;
  let inSection     = false;

  const flushSection = (endLine: number) => {
    const content = sectionLines.join("\n").trimEnd();
    if (!content || (!inSection && !content.trim())) return;
    // Breadcrumb is the full ancestor path: "# H1 > ## H2 > ### H3"
    const breadcrumb = headingStack
      .map(h => "#".repeat(h.level) + " " + h.title)
      .join(" > ");
    sections.push({ level: sectionLevel, title: sectionTitle, breadcrumb, startLine: sectionStart, endLine, content });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m    = line.match(/^(#{1,3})\s+(.+)$/);

    if (m) {
      flushSection(i); // flush previous section before updating stack

      const level = m[1]!.length;
      const title = m[2]!.trim();

      // Maintain ancestor stack: pop headings of same or deeper level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });

      sectionLevel = level;
      sectionTitle = title;
      sectionStart = i + 1;
      sectionLines = [line];
      inSection    = true;
    } else {
      sectionLines.push(line);
    }
  }
  flushSection(lines.length);

  // No headings found → fall back to plain-text chunking
  if (sections.length === 0) return parsePlainText(filePath, source);

  const OVERLAP = 200;
  const chunks: CodeChunk[] = [];

  for (const sec of sections) {
    const subChunks = splitTextIntoChunks(sec.content, MAX_CHUNK_CHARS, OVERLAP);
    const total     = subChunks.length;

    subChunks.forEach((sub, idx) => {
      chunks.push({
        content:   sub,
        filePath,
        chunkType: "section",
        name:      total > 1 ? `${sec.title} [${idx + 1}/${total}]` : sec.title,
        signature: sec.breadcrumb || sec.title,
        startLine: sec.startLine,
        endLine:   sec.endLine,
        language:  "markdown",
        jsdoc:     "",
      });
    });
  }

  return chunks;
}

function parsePlainText(filePath: string, source: string): CodeChunk[] {
  const stem     = basename(filePath, extname(filePath));
  const allLines = source.split("\n");

  if (source.length <= MAX_CHUNK_CHARS) {
    return [{
      content:   source.trimEnd(),
      filePath,
      chunkType: "document",
      name:      stem,
      signature: "",
      startLine: 1,
      endLine:   allLines.length,
      language:  "text",
      jsdoc:     "",
    }];
  }

  const subChunks = splitTextIntoChunks(source, MAX_CHUNK_CHARS, 200);
  const total     = subChunks.length;

  return subChunks.map((sub, idx) => ({
    content:   sub,
    filePath,
    chunkType: "document",
    name:      total > 1 ? `${stem} [${idx + 1}/${total}]` : stem,
    signature: "",
    startLine: 1,
    endLine:   allLines.length,
    language:  "text",
    jsdoc:     "",
  }));
}

// ── public API ────────────────────────────────────────────────────────────────

export async function parseFile(filePath: string, source: string): Promise<CodeChunk[]> {
  const ext   = extname(filePath).toLowerCase();
  const entry = EXT_MAP[ext];
  if (!entry) return [];

  if (entry.kind === "data") {
    if (entry.parser === "yaml") return parseYaml(filePath, source);
    if (entry.parser === "json") return parseJsonFile(filePath, source);
    if (entry.parser === "toml") return parseTomlFile(filePath, source);
    return [];
  }

  if (entry.kind === "text") {
    if (entry.parser === "markdown")  return parseMarkdown(filePath, source);
    if (entry.parser === "plaintext") return parsePlainText(filePath, source);
    return [];
  }

  const parser = await getParser(entry.wasmKey);
  const def    = LANG_DEFS[entry.defKey];
  if (!def) return [];

  const tree  = parser.parse(source)!;
  const root  = tree.rootNode as unknown as SyntaxNode;
  const lines = source.split("\n");
  const chunks: CodeChunk[] = [];
  walkTree(root, filePath, lines, chunks, def);

  // Extract imports for this file and attach to each chunk (only the first chunk
  // per file really needs them, but the indexer reads them from chunks[0]).
  const imports = extractImports(root, def.language);
  if (imports.length > 0 && chunks.length > 0) {
    // Attach to all chunks so the indexer can see them without special-casing.
    for (const chunk of chunks) {
      chunk.imports = imports;
    }
  }

  return chunks;
}

/**
 * Extract raw import source strings from a source file without full chunk parsing.
 * Used by the indexer to build the dependency graph.
 */
export async function extractFileImports(filePath: string, source: string): Promise<string[]> {
  const ext   = extname(filePath).toLowerCase();
  const entry = EXT_MAP[ext];
  if (!entry || entry.kind === "data" || entry.kind === "text") return [];

  const parser = await getParser(entry.wasmKey);
  const def    = LANG_DEFS[entry.defKey];
  if (!def) return [];

  const tree = parser.parse(source)!;
  return extractImports(tree.rootNode as unknown as SyntaxNode, def.language);
}

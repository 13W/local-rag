import { createRequire } from "node:module";
import { dirname, join, basename, extname } from "node:path";
import { loadAll } from "js-yaml";
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
  readonly extractName:    (node: SyntaxNode) => string;
  readonly docStyle:       "jsdoc" | "slashslash" | "none";
  readonly importNode?:    string;
}

// ── extension map ─────────────────────────────────────────────────────────────

type ExtEntry =
  | { kind: "treesitter"; wasmKey: string; defKey: string }
  | { kind: "data";       parser:  "yaml" | "toml" | "json" };

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
  "function_declaration", "arrow_function", "method_definition",
  "function_signature", "class_declaration", "abstract_class_declaration",
  "interface_declaration", "type_alias_declaration", "enum_declaration",
  "export_statement", "lexical_declaration",
]);

function extractNameIdentifier(node: SyntaxNode): string {
  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier"
    ) {
      return child.text;
    }
    if (TS_EXTRACT_NODES.has(child.type)) return extractNameIdentifier(child);
  }
  return "";
}

function extractNameField(node: SyntaxNode): string {
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
        name:      def.extractName(node),
        signature: getSignature(node),
        startLine: node.startPosition.row + 1,
        endLine:   node.endPosition.row + 1,
        language:  def.language,
        jsdoc:     extractDoc(lines, node.startPosition.row, def.docStyle),
        chunkRole: "parent",
      };
      if (parentKey !== undefined) chunk.parentKey = parentKey;
      chunks.push(chunk);
      // Recurse with children knowing their parent's key
      for (const child of node.children) walkTree(child, filePath, lines, chunks, def, myKey);
      return;
    }

    const chunk: CodeChunk = {
      content:   text,
      filePath,
      chunkType: def.chunkTypeMap[node.type] ?? "block",
      name:      def.extractName(node),
      signature: getSignature(node),
      startLine: node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
      language:  def.language,
      jsdoc:     extractDoc(lines, node.startPosition.row, def.docStyle),
      chunkRole: parentKey !== undefined ? "child" : "regular",
    };
    if (parentKey !== undefined) chunk.parentKey = parentKey;
    chunks.push(chunk);
    return; // do not recurse into this node's children
  }

  for (const child of node.children) walkTree(child, filePath, lines, chunks, def, parentKey);
}

// ── data format parsers ───────────────────────────────────────────────────────

function parseJsonFile(filePath: string, source: string): CodeChunk[] {
  if (source.length > 100_000) return [];
  const data  = JSON.parse(source) as unknown;
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
  if (!entry || entry.kind === "data") return [];

  const parser = await getParser(entry.wasmKey);
  const def    = LANG_DEFS[entry.defKey];
  if (!def) return [];

  const tree = parser.parse(source)!;
  return extractImports(tree.rootNode as unknown as SyntaxNode, def.language);
}

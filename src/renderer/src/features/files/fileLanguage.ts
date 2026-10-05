export const MARKDOWN_EXTENSIONS: readonly string[] = ["md", "markdown", "mdown", "mkd"];

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", json: "json", jsonc: "json", css: "css", scss: "scss",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", sql: "sql", toml: "ini", ini: "ini", kt: "kotlin",
  swift: "swift", lua: "lua", r: "r", pl: "perl", diff: "diff", patch: "diff", makefile: "makefile"
};

function extensionOf(path: string): string | null {
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? null : basename.slice(dot + 1).toLowerCase();
}

export function isMarkdownPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension !== null && MARKDOWN_EXTENSIONS.includes(extension);
}

export function detectFileLanguage(path: string): string | null {
  const extension = extensionOf(path);
  return extension !== null && Object.hasOwn(EXTENSION_LANGUAGE_MAP, extension) ? EXTENSION_LANGUAGE_MAP[extension] : null;
}

export const COMMON_LANGUAGES: readonly string[] = Array.from(new Set(Object.values(EXTENSION_LANGUAGE_MAP))).sort();

const FENCED_CODE_BLOCK = /```([^\n`]*)\n?([\s\S]*?)```/g;
const MARKDOWN_LINK = /\[([^\]]+)\]\((?:[^()\s]+|\([^)]*\))+\)/g;
const RAW_URL = /https?:\/\/\S+/g;
const HTML_TAG = /<[^>]+>/g;

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "shell",
  c: "C",
  cpp: "C plus plus",
  cs: "C sharp",
  css: "CSS",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  powershell: "PowerShell",
  py: "Python",
  python: "Python",
  sh: "shell",
  sql: "SQL",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
};

function summarizeCodeBlock(language: string, code: string): string {
  const trimmed = code.trim();
  const lines = trimmed.length === 0 ? 0 : trimmed.split(/\r?\n/).length;
  const normalizedLanguage = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const languageLabel = LANGUAGE_LABELS[normalizedLanguage] ?? (normalizedLanguage || "code");
  if (lines <= 1) return ` A short ${languageLabel} code example is included. `;
  return ` A ${languageLabel} code example with ${lines} lines is included. `;
}

export function prepareTextForSpeech(markdown: string): string {
  return markdown
    .replace(FENCED_CODE_BLOCK, (_match, language: string, code: string) =>
      summarizeCodeBlock(language, code),
    )
    .replace(MARKDOWN_LINK, "$1")
    .replace(RAW_URL, " a link ")
    .replace(HTML_TAG, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\|/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSpeechText(text: string, maxLength = 3800): string[] {
  if (text.length <= maxLength) return text ? [text] : [];
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = `${current}${sentence}`.trim();
    if (candidate.length <= maxLength) {
      current = `${candidate} `;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    current = "";
    if (sentence.length <= maxLength) {
      current = `${sentence.trim()} `;
      continue;
    }
    for (let offset = 0; offset < sentence.length; offset += maxLength) {
      chunks.push(sentence.slice(offset, offset + maxLength).trim());
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

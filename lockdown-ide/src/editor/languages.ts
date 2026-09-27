// File-extension → Monaco language mapping, plus lightweight IntelliSense for
// languages Monaco has no language service for (Python, Markdown).
//
// Only a *type* import of Monaco here, so the mapping stays unit-testable.

import type * as Monaco from 'monaco-editor/editor';
import { extname } from './fileSystem';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
};

const LANGUAGE_LABELS: Record<string, string> = {
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  json: 'JSON',
  markdown: 'Markdown',
  xml: 'XML',
  yaml: 'YAML',
  plaintext: 'Plain Text',
};

export function languageForPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[extname(path)] ?? 'plaintext';
}

export function languageLabel(languageId: string): string {
  return LANGUAGE_LABELS[languageId] ?? languageId;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match',
  'case', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
];

const PYTHON_BUILTINS = [
  'abs', 'all', 'any', 'bin', 'bool', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'dict', 'dir',
  'divmod', 'enumerate', 'filter', 'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash', 'help', 'hex',
  'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'object',
  'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
];

const PYTHON_SNIPPETS: Array<[label: string, body: string, detail: string]> = [
  ['def', 'def ${1:name}(${2:args}):\n\t${3:pass}', 'Function definition'],
  ['class', 'class ${1:Name}:\n\tdef __init__(self${2:, args}):\n\t\t${3:pass}', 'Class definition'],
  ['if', 'if ${1:condition}:\n\t${2:pass}', 'if statement'],
  ['ifelse', 'if ${1:condition}:\n\t${2:pass}\nelse:\n\t${3:pass}', 'if/else statement'],
  ['for', 'for ${1:item} in ${2:items}:\n\t${3:pass}', 'for loop'],
  ['forrange', 'for ${1:i} in range(${2:10}):\n\t${3:pass}', 'for loop over range()'],
  ['while', 'while ${1:condition}:\n\t${2:pass}', 'while loop'],
  ['try', 'try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:error}:\n\t${4:raise}', 'try/except'],
  ['with', 'with ${1:expression} as ${2:target}:\n\t${3:pass}', 'with statement'],
  ['main', 'def main():\n\t${1:pass}\n\n\nif __name__ == "__main__":\n\tmain()', 'Script entry point'],
  ['lc', '[${1:x} for ${1:x} in ${2:items}]', 'List comprehension'],
];

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MARKDOWN_SNIPPETS: Array<[label: string, body: string, detail: string]> = [
  ['h1', '# ${1:Heading}', 'Heading 1'],
  ['h2', '## ${1:Heading}', 'Heading 2'],
  ['h3', '### ${1:Heading}', 'Heading 3'],
  ['link', '[${1:text}](${2:url})', 'Link'],
  ['image', '![${1:alt}](${2:src})', 'Image'],
  ['code', '```${1:js}\n${2}\n```', 'Fenced code block'],
  ['table', '| ${1:Column} | ${2:Column} |\n| --- | --- |\n| ${3} | ${4} |', 'Table'],
  ['task', '- [ ] ${1:task}', 'Task list item'],
];

export function registerLanguageExtras(monaco: typeof Monaco): void {
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;

  const wordRange = (model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
  };

  const snippetItems = (snippets: typeof PYTHON_SNIPPETS, range: Monaco.IRange): Monaco.languages.CompletionItem[] =>
    snippets.map(([label, body, detail]) => ({
      label,
      kind: CompletionItemKind.Snippet,
      insertText: body,
      insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
      detail,
      range,
    }));

  monaco.languages.registerCompletionItemProvider('python', {
    provideCompletionItems(model, position) {
      const range = wordRange(model, position);
      return {
        suggestions: [
          ...PYTHON_KEYWORDS.map((keyword) => ({
            label: keyword,
            kind: CompletionItemKind.Keyword,
            insertText: keyword,
            range,
          })),
          ...PYTHON_BUILTINS.map((name) => ({
            label: name,
            kind: CompletionItemKind.Function,
            insertText: `${name}($0)`,
            insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
            detail: 'built-in',
            range,
          })),
          ...snippetItems(PYTHON_SNIPPETS, range),
        ],
      };
    },
  });

  monaco.languages.registerCompletionItemProvider('markdown', {
    provideCompletionItems(model, position) {
      return { suggestions: snippetItems(MARKDOWN_SNIPPETS, wordRange(model, position)) };
    },
  });
}

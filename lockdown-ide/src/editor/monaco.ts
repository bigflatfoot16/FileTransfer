// Monaco bootstrap: workers, languages, theme and the editor factory.
//
// Monaco 0.56+ ships tree-shakeable entry points, so only the languages the
// IDE supports are bundled instead of all ~80.

import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';
// Rich language services (IntelliSense, validation, formatting) for HTML, CSS, JSON, JS/TS.
import 'monaco-editor/languages/features/register.all';
import { javascriptDefaults, typescriptDefaults, ScriptTarget, ModuleKind, JsxEmit } from 'monaco-editor/languages/features/typescript/register';

import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';

import { registerLanguageExtras } from './languages';

export { monaco };

let initialized = false;

export function initMonaco(): void {
  if (initialized) return;
  initialized = true;

  // Language services run in web workers, bundled locally by Vite.
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new JsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker();
        case 'typescript':
        case 'javascript':
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };

  // JS/TS IntelliSense across workspace files (eager sync lets script.js see
  // symbols declared in other open models).
  const compilerOptions = {
    target: ScriptTarget.ES2020,
    module: ModuleKind.ESNext,
    allowJs: true,
    allowNonTsExtensions: true,
    jsx: JsxEmit.Preserve,
  };
  javascriptDefaults.setCompilerOptions(compilerOptions);
  typescriptDefaults.setCompilerOptions(compilerOptions);
  javascriptDefaults.setEagerModelSync(true);
  typescriptDefaults.setEagerModelSync(true);

  registerLanguageExtras(monaco);

  // VS Code "Dark+" flavoured theme.
  monaco.editor.defineTheme('lockdown-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'tag', foreground: '569CD6' },
      { token: 'attribute.name', foreground: '9CDCFE' },
      { token: 'attribute.value', foreground: 'CE9178' },
    ],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.lineHighlightBackground': '#2a2d2e80',
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#c6c6c6',
    },
  });
}

export function createEditor(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(container, {
    model: null,
    theme: 'lockdown-dark',
    automaticLayout: true,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
    tabSize: 2,
    minimap: { enabled: true },
    smoothScrolling: true,
    bracketPairColorization: { enabled: true },
    fixedOverflowWidgets: true,
    // SECURITY: no Monaco context menu (it offers Copy/Cut/Paste entries and
    // right-click is disabled app-wide anyway).
    contextmenu: false,
    // SECURITY: no dropping external text/files into the editor, and no
    // "paste as…" providers. Internal drag-to-move of a selection still works.
    dropIntoEditor: { enabled: false },
    pasteAs: { enabled: false },
    // SECURITY: Ctrl+click on a URL would try to open a window.
    links: false,
    // Linux middle-click paste from the PRIMARY selection.
    selectionClipboard: false,
    // Rich-text copy only matters for the OS clipboard, which we never use.
    copyWithSyntaxHighlighting: false,
  });
}

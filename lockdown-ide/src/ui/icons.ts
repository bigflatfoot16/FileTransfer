// File-type icons, drawn with Monaco's bundled codicon font.

import { extname } from '../editor/fileSystem';

const ICONS: Record<string, string> = {
  html: 'code icon-html',
  htm: 'code icon-html',
  css: 'symbol-color icon-css',
  scss: 'symbol-color icon-css',
  less: 'symbol-color icon-css',
  js: 'symbol-method icon-js',
  mjs: 'symbol-method icon-js',
  cjs: 'symbol-method icon-js',
  jsx: 'symbol-method icon-js',
  ts: 'symbol-method icon-ts',
  tsx: 'symbol-method icon-ts',
  py: 'symbol-namespace icon-py',
  json: 'json icon-json',
  md: 'markdown icon-md',
};

export function fileIconClass(path: string): string {
  const [codicon, color] = (ICONS[extname(path)] ?? 'file icon-file').split(' ');
  return `file-icon codicon codicon-${codicon} ${color}`;
}

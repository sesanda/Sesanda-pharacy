// Pulls named top-level functions out of index.html (single-file app, no module system) so the
// pure accounting / search helpers can be unit tested exactly as shipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
export function extractFunction(name){
  const start = html.indexOf('\nfunction ' + name + '(');
  if(start<0) throw new Error('function not found: ' + name);
  // skip the parameter list first (it may contain destructuring braces), then match the body
  let i = html.indexOf('(', start), depth = 0;
  for(; i<html.length; i++){
    if(html[i]==='(') depth++;
    else if(html[i]===')'){ depth--; if(depth===0) break; }
  }
  i = html.indexOf('{', i); depth = 0;
  for(; i<html.length; i++){
    const ch = html[i];
    if(ch==='{') depth++;
    else if(ch==='}'){ depth--; if(depth===0) return html.slice(start+1, i+1); }
  }
  throw new Error('unterminated function: ' + name);
}
export function loadHelpers(names){
  const src = names.map(extractFunction).join('\n') + '\nreturn {' + names.join(',') + '};';
  return new Function(src)();
}

/**
 * 把 index.html 里的 <i class="ic ic-xxx"></i> 占位替换成 sprite 引用。
 * 一次性工具：node tools/replace-icons.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'index.html');
let s = fs.readFileSync(file, 'utf8');

let n = 0;
s = s.replace(/<i class="ic ic-([a-z-]+)"><\/i>/g, (_, id) => {
  n++;
  return `<svg class="ic" aria-hidden="true"><use href="#ic-${id}"></use></svg>`;
});

fs.writeFileSync(file, s, 'utf8');

const left = (s.match(/<i class="ic/g) || []).length;
const uses = (s.match(/<use href=/g) || []).length;
console.log(`已替换 ${n} 处；剩余 <i class="ic"> ${left} 个；<use> 引用 ${uses} 个`);

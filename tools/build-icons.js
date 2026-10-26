/**
 * 把 assets/ui/*.svg 编译成页面内的 SVG sprite。
 *
 * 为什么不用 <img> 或 CSS mask：
 *   · <img src="...svg"> 不继承 currentColor，在深色按钮上会变成看不见的黑图标
 *   · CSS mask 对没有内在尺寸的 SVG 支持不稳，实测在部分环境下完全不显示
 * 内联 <symbol> 后，图标直接用 stroke="currentColor" 跟随按钮文字色，最可靠。
 *
 * 用法： node tools/build-icons.js
 * 产物： 写入 index.html 的 <svg id="icon-sprite"> 块（被 <!-- ICON_SPRITE --> 标记包裹）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const uiDir = path.join(rootDir, 'assets', 'ui');
const htmlPath = path.join(rootDir, 'index.html');

const START = '<!-- ICON_SPRITE_START (由 tools/build-icons.js 生成，请勿手改) -->';
const END = '<!-- ICON_SPRITE_END -->';

function symbols() {
  const files = fs.readdirSync(uiDir).filter(f => f.endsWith('.svg')).sort();
  return files.map(f => {
    const id = path.basename(f, '.svg');
    const src = fs.readFileSync(path.join(uiDir, f), 'utf8');

    const rootTag = (src.match(/<svg[^>]*>/) || [''])[0];
    const viewBox = (rootTag.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 24 24';

    // 关键：fill / stroke / stroke-width 这些表现属性原本写在根 <svg> 上，
    // 只搬内部节点会全部丢失，图标要么变实心黑块要么整片不显示。
    // 这里把根节点上的表现属性原样搬到 <symbol> 上。
    const PRESENTATION = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
    const attrs = PRESENTATION
      .map(name => {
        const m = rootTag.match(new RegExp(name + '="([^"]*)"'));
        return m ? `${name}="${m[1]}"` : '';
      })
      .filter(Boolean)
      .join(' ');

    const inner = src
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .trim();
    return `  <symbol id="${id}" viewBox="${viewBox}" ${attrs}>${inner}</symbol>`;
  }).join('\n');
}

const block = [
  START,
  '<svg id="icon-sprite" width="0" height="0" aria-hidden="true" style="position:absolute">',
  symbols(),
  '</svg>',
  END
].join('\n');

let html = fs.readFileSync(htmlPath, 'utf8');
const re = new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

if (re.test(html)) {
  html = html.replace(re, block);
} else {
  // 首次插入：放到 <body> 之后
  html = html.replace('<body>', '<body>\n\n' + block + '\n');
}
fs.writeFileSync(htmlPath, html, 'utf8');

const count = (block.match(/<symbol /g) || []).length;
console.log(`已生成 ${count} 个图标 symbol 并写入 index.html`);

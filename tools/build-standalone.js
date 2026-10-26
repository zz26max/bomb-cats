/**
 * 打包成「单文件版」：把素材全部内联成 data URI，
 * 生成一个不依赖任何外部文件的 HTML，双击即开、可丢进任何预览器。
 *
 * 为什么需要它：
 *   某些预览环境（编辑器侧边栏、聊天工具的 HTML 预览、srcdoc iframe）
 *   只渲染单个 HTML，取不到同级的 assets/ 目录。CSS/JS 有时被内联后能跑，
 *   但 <img> 和 CSS url() 会全部裂图。单文件版从根上绕开这个问题。
 *
 * 用法： node tools/build-standalone.js
 * 产物： 炸弹猫-单文件版.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const OUT = path.join(rootDir, '炸弹猫-单文件版.html');

const MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
};

function dataUri(relPath) {
  const full = path.join(rootDir, relPath);
  if (!fs.existsSync(full)) {
    console.warn('  ! 缺文件，跳过:', relPath);
    return null;
  }
  const mime = MIME[path.extname(relPath).toLowerCase()] || 'application/octet-stream';
  return 'data:' + mime + ';base64,' + fs.readFileSync(full).toString('base64');
}

/* ---------- 1. 收集需要内联的素材 ---------- */

const CARDS = require(path.join(rootDir, 'src/core/cards.js')).CARDS;
const used = new Set([
  // CSS 里用到的
  'assets/cards/frame.webp',
  'assets/cards/back.webp',
  'assets/table/felt.webp',
  'assets/table/vignette.webp',
  'assets/table/emblem.svg',
  'assets/cats/frame.svg',
  'assets/fx/boom-sheet.webp',
  // HTML 里用到的
  'assets/brand/logo-cn.svg',
  'assets/brand/logo-en.svg',
  'assets/brand/favicon-32.png',
  'assets/art/banner.webp',
  'assets/cats/cat-01.webp',
  // JS 里用到的
  'assets/cats/out-sticker.svg',
  'assets/ui/discard-empty.svg',
  'assets/cards/back.webp',
  'assets/art/win.webp',
  'assets/art/lose.webp'
]);

Object.keys(CARDS).forEach(t => {
  used.add('assets/cards/icon/' + t + '.webp');
  used.add('assets/cards/face/' + t + '.webp');
});
for (let i = 1; i <= 5; i++) {
  used.add('assets/cats/cat-0' + i + '.webp');
  used.add('assets/cats/cat-0' + i + '-dead.webp');
}

/* ---------- 2. 生成映射 ---------- */

console.log('\n内联素材…');
const map = {};
let totalBytes = 0;
[...used].sort().forEach(p => {
  const uri = dataUri(p);
  if (uri) {
    map[p] = uri;
    totalBytes += uri.length;
  }
});
console.log(`  共 ${Object.keys(map).length} 个素材，约 ${(totalBytes / 1024 / 1024).toFixed(2)} MB（base64）`);

/* ---------- 3. 组装 HTML ---------- */

let html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

// 3.1 favicon / 图片：src="assets/..." -> data URI
html = html.replace(/(src|href)="(assets\/[^"]+)"/g, (m, attr, p) => {
  return map[p] ? attr + '="' + map[p] + '"' : m;
});

// 3.2 样式：<link rel=stylesheet> -> <style>，并把 CSS 里的 url("../assets/...") 换成 data URI
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, href) => {
  let css = fs.readFileSync(path.join(rootDir, href), 'utf8');
  css = css.replace(/url\(\s*["']?\.\.\/(assets\/[^"')]+)["']?\s*\)/g, (mm, p) => {
    return map[p] ? 'url("' + map[p] + '")' : mm;
  });
  return '<style>\n' + css + '\n</style>';
});

// 3.3 脚本：<script src="..."> -> 内联，并在最前面注入素材映射
const assetScript = 'window.__ASSETS = ' + JSON.stringify(map) + ';\n';

html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(rootDir, src), 'utf8');
  // 映射必须在 view.js / main.js 之前就位
  const prelude = src.indexOf('src/ui/view.js') >= 0 ? assetScript : '';
  return '<script>\n' + prelude + code + '\n</script>';
});

// 3.4 标题标注版本，避免和普通版混淆
html = html.replace('<title>', '<title>[单文件版] ');

fs.writeFileSync(OUT, html, 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\n已生成： ${path.basename(OUT)}  （${kb} KB）`);
console.log('双击即可运行，无需 assets/ 目录。\n');

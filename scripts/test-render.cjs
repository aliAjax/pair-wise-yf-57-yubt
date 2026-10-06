// 页面渲染冒烟测试：mock Taro 与样式，用真实 Redux store + ReactDOMServer 渲染
const Module = require('module');
const path = require('path');
const memory = {};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@tarojs/taro') {
    return {
      getStorageSync: (k) => (k in memory ? memory[k] : ''),
      setStorageSync: (k, v) => { memory[k] = String(v); },
      removeStorageSync: (k) => { delete memory[k]; },
      showToast: () => {}
    };
  }
  if (request.endsWith('.scss') || request.endsWith('.css')) return {};
  return origLoad.apply(this, arguments);
};
require('@babel/register')({
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], ['@babel/preset-react', { runtime: 'automatic' }], '@babel/preset-typescript'],
  extensions: ['.js', '.ts', '.tsx'], cache: false
});

globalThis.window = {};
const React = require('react');
const { Provider } = require('react-redux');
const { renderToString } = require('react-dom/server');
const { store } = require(path.join(process.cwd(), 'src/store/index.ts'));
const Page = require(path.join(process.cwd(), 'src/pages/index/index.tsx')).default;

const html = renderToString(React.createElement(Provider, { store }, React.createElement(Page)));

const checks = ['野外巡护离线调查', '巡护批次', '批次与剩余项', '记录列表', '同步日志', '开始新的巡护批次', '重连后全部重试', '待同步', '已核验样本不退回草稿'];
let failed = 0;
for (const c of checks) {
  const ok = html.includes(c);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} 页面包含「${c}」`);
}
console.log(`\nrendered length: ${html.length}`);
process.exit(failed ? 1 : 0);

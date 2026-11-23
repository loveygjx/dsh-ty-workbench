import * as ty from './tianyuan.js';
const r = await ty.callTool('__nonexistent__', {}).catch(e => null);
// 直接走 tools/list
import('./tianyuan.js').then(async () => {
  const mod = await import('./tianyuan.js');
  if (!mod.listTools) { console.log('无 listTools 导出'); return; }
  const t = await mod.listTools();
  console.log(JSON.stringify(t).slice(0, 200));
});

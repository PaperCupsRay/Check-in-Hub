import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../src/ui.html',import.meta.url),'utf8');
function functionSource(name) {
  const start=html.indexOf(`    function ${name}(`)>=0?html.indexOf(`    function ${name}(`):html.indexOf(`    async function ${name}(`);
  assert.ok(start>=0,name);
  return html.slice(start,html.indexOf('\n    }',start)+6);
}
const box={innerHTML:''};
const field={key:'options.retryCount',type:'number',label:'retry',placeholder:'2',min:0,max:5,step:1};
const render={currentType:()=> 'newapi',adapterOf:()=>({fields:[field]}),$:()=>box,escapeHtml:x=>String(x)};
vm.createContext(render);vm.runInContext(`${functionSource('renderFields')}\nrenderFields();`,render);
assert.match(box.innerHTML,/min="0"/);assert.match(box.innerHTML,/max="5"/);assert.match(box.innerHTML,/step="1"/);
const editCode=html.slice(html.indexOf('    function deleteByPath('),html.indexOf('    function getByPath('));
const edit=vm.runInNewContext(`${editCode}\nmergeChannelEdit`);
const prev={type:'newapi',auth:{},options:{retryCount:4}};
assert.equal(edit(prev,{type:'newapi',auth:{},options:{retryCount:'0'}}).options.retryCount,'0');
assert.equal(edit(prev,{type:'newapi',auth:{},options:{},_clearedKeys:['options.retryCount']}).options.retryCount,undefined);
assert.equal(prev.options.retryCount,4);
console.log('PASS retry number bounds, zero persistence and clear-to-default');

let saved;const toasts=[];
const context={channels:[{id:'fixture',name:'fixture',type:'newapi',auth:{},options:{runner:'worker'}}],
  api:async()=>({ok:false,pending:true,message:'正在自动兜底'}),maybeRefreshUser:async(ch,d)=>d,
  actionLabel:x=>x,log(){},showToast:(...args)=>toasts.push(args),buildSummary:(action,d)=>d.message,
  pickQuotaPerUnit:()=>500000,numOrNull:x=>x==null?null:Number(x),moneyLabel:()=>'',
  extractQuotaInfo:()=>null,saveChannels(){saved=structuredClone(context.channels[0]);},console};
vm.createContext(context);
vm.runInContext(`${functionSource('mergeTokens')}\n${functionSource('runChannel')}\nthis.run=runChannel;`,context);
await context.run('fixture','checkin');
assert.equal(saved.lastResult.pending,true);assert.equal(saved.lastResult.ok,false);assert.equal(saved.lastResult.short,'待确认');
assert.equal(toasts.at(-1)[2],'info');assert.match(toasts.at(-1)[0],/等待结果/);
console.log('PASS accepted pending result is saved as pending and shown as info, not final failure');

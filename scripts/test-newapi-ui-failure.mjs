import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../src/ui.html',import.meta.url),'utf8');
const merge=html.slice(html.indexOf('    function mergeTokens('),html.indexOf('    async function maybeRefreshUser'));
const start=html.indexOf('    async function runChannel(');
const run=html.slice(start,html.indexOf('\n    }',start)+6);
for(const tokens of [{cookie:'rotated',accessToken:'fresh',authSession:'new-session'},null]) {
 const error=Object.assign(new Error('business failed'),{data:{message:'business failed',tokens}});
 let saved;
 const context={channels:[{id:'x',name:'fixture',type:'newapi',auth:{cookie:'old',token:'old'}}],
 log(){},showToast(){},actionLabel:x=>x,buildSummary:()=> 'business failed',api:async()=>{throw error},
 saveChannels(){saved=structuredClone(context.channels[0]);},console};
 vm.createContext(context);
 vm.runInContext(`${merge}\n${run}\nthis.run=runChannel;`,context);
 await assert.rejects(context.run('x','status'),/business failed/);
 assert.equal(saved.auth.cookie,tokens?'rotated':'old');
 assert.equal(saved.auth.token,tokens?'fresh':'old');
 if(tokens)assert.equal(saved.auth.authSession,'new-session');
 assert.equal(saved.lastResult.ok,false);
}
console.log('PASS UI preserves refreshed credentials on business failure, and retains existing credentials when none returned');

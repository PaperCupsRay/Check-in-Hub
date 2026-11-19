"""Offline browser executor retry tests, no browsers or network."""
import importlib.util
import pathlib
import time
import unittest
from unittest.mock import AsyncMock, patch

spec=importlib.util.spec_from_file_location('browser_checkin', pathlib.Path(__file__).with_name('browser-checkin.py'))
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class BrowserRetry(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, replies, *, retry=None, proxies=None, deadline=None):
        ch={'name':'fixture','type':'newapi','auth':{'token':'old'},'options':{}}
        if retry is not None:ch['options']['retryCount']=retry
        run=AsyncMock(side_effect=replies)
        sleep=AsyncMock()
        with patch.object(mod,'log',lambda *args:None):
            result=await mod.run_browser_channel(ch, proxies or [], deadline if deadline is not None else time.monotonic()+1000,run=run,sleep=sleep)
        return result,run,sleep,ch

    def test_config_matches_js(self):
        for value in [None,'',' ',True,False,[],{},'bad',float('nan'),float('inf'),-1,1.5]:
            self.assertEqual(mod.retry_count({'options':{'retryCount':value}}),2)
        self.assertEqual(mod.retry_count({'options':{'retryCount':'0'}}),0)
        self.assertEqual(mod.retry_count({'options':{'retryCount':99}}),5)
        self.assertEqual(mod.browser_attempt_plan({'options':{}},['https://safe:443']),[None,'https://safe:443','https://safe:443'])

    async def test_success_with_captcha_words_stops_immediately(self):
        r,run,sleep,_=await self.run_case([{'name':'fixture','ok':True,'message':'Turnstile/hCaptcha 签到成功'}])
        self.assertTrue(r['ok']);self.assertEqual(run.await_count,1);sleep.assert_not_awaited();self.assertEqual(r['attempts'],1)

    async def test_no_proxy_still_retries_transient_failure_three_rounds(self):
        failed={'name':'fixture','ok':False,'message':'Too many requests','retryable':True}
        r,run,sleep,_=await self.run_case([dict(failed),dict(failed),dict(failed)])
        self.assertFalse(r['ok']);self.assertEqual(run.await_count,3);self.assertEqual([c.args[0] for c in sleep.await_args_list],[2,5])
        self.assertEqual(r['attempts'],3)

    async def test_zero_and_permanent_stop(self):
        for kwargs, failure in [({'retry':0},{'ok':False,'message':'network-error','retryable':True}),
                                ({},{'ok':False,'message':'Turnstile refused','retryable':False}),
                                ({},{'ok':False,'message':'Unauthorized','retryable':True})]:
            r,run,sleep,_=await self.run_case([{'name':'fixture',**failure}],**kwargs)
            self.assertFalse(r['ok']);self.assertEqual(run.await_count,1);sleep.assert_not_awaited()

    async def test_exception_retries_and_fresh_tokens_are_retained(self):
        seen=[]
        async def runner(ch, proxy):
            seen.append((dict(ch['auth']),proxy))
            if len(seen)==1:raise OSError('network error')
            if len(seen)==2:return {'name':'fixture','ok':False,'retryable':True,'message':'network-error','newTokens':{'accessToken':'fresh','cookie':'new'}}
            return {'name':'fixture','ok':True,'message':'signed'}
        ch={'name':'fixture','type':'newapi','auth':{'token':'old'},'options':{}}
        with patch.object(mod,'log',lambda *args:None):
            r=await mod.run_browser_channel(ch,['https://safe1:443','https://safe2:443'],time.monotonic()+1000,run=runner,sleep=AsyncMock())
        self.assertTrue(r['ok']);self.assertEqual(r['attempts'],3);self.assertEqual(r['newTokens']['accessToken'],'fresh')
        self.assertEqual(seen[2][0]['token'],'fresh');self.assertEqual(seen[2][0]['cookie'],'new');self.assertEqual(ch['auth'],{'token':'old'})
        self.assertEqual([x[1] for x in seen],[None,'https://safe1:443','https://safe2:443'])

    async def test_exhausted_job_budget_does_not_start(self):
        r,run,_,_=await self.run_case([],deadline=time.monotonic()-1)
        run.assert_not_awaited();self.assertFalse(r['ok']);self.assertEqual(r['attempts'],0)

    async def test_timeout_respects_remaining_job_budget(self):
        limits=[]
        async def limited(coro,timeout):
            limits.append(timeout);return await coro
        with patch.object(mod.asyncio,'wait_for',limited):
            r,_,_,_=await self.run_case([{'name':'fixture','ok':True,'message':'signed'}],deadline=time.monotonic()+20)
        self.assertTrue(r['ok']);self.assertGreater(limits[0],0);self.assertLessEqual(limits[0],20)

if __name__=='__main__':unittest.main()

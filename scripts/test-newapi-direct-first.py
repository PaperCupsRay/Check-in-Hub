"""Offline tests: token-free NewAPI POST must precede all captcha work."""
import contextlib
import importlib.util
import pathlib
import unittest
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location('browser_checkin', pathlib.Path(__file__).with_name('browser-checkin.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Page:
    def __init__(self):
        self.context = self
        self.evaluations = []

    async def goto(self, *args, **kwargs):
        pass

    async def wait_for_timeout(self, *args):
        pass

    async def add_cookies(self, *args):
        pass

    async def evaluate(self, expression, *args):
        self.evaluations.append(expression)
        if 'rendered: !!window._tsRendered' in expression:
            return {'rendered': True}
        return {}


class DirectFirst(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, replies, *, site_status=None, already=False, options=None):
        page = Page()

        @contextlib.asynccontextmanager
        async def browser_page(proxy):
            yield page

        mocks = {
            'browser_page': browser_page,
            'seed_localstorage_auth': AsyncMock(),
            'confirm_checked_in': AsyncMock(return_value={'ok': True} if already else None),
            'inpage_checkin': AsyncMock(side_effect=replies),
            'attach_quota': AsyncMock(),
            'captcha_status_enabled': AsyncMock(return_value=None),
            'read_site_status': AsyncMock(return_value=(site_status or {'turnstile_check': True}, '')),
            'detect_recaptcha': AsyncMock(return_value=''),
            'wait_any_token': AsyncMock(return_value=('fresh-token', 'self')),
            'selfmounted_captcha_checkin': AsyncMock(return_value={'ok': True}),
            'recaptcha_site_ui_checkin': AsyncMock(return_value={'ok': True}),
            'captcha_checkin': AsyncMock(return_value={'ok': True}),
            'log': lambda *args: None,
        }
        channel = {'name': 'future', 'baseUrl': 'https://future.example.test',
                   'auth': {'cookie': 'session=fixture'}, 'options': {'turnstileSiteKey': 'fixture-key', **(options or {})}}
        with patch.multiple(mod, **mocks):
            result = await mod.checkin_one(channel)
        return result, page, mocks

    async def test_direct_success_skips_even_declared_captcha(self):
        for flags in [{'turnstile_check': True}, {'checkin_turnstile_check': True, 'checkin_hcaptcha_check': True}]:
            result, page, mocks = await self.run_case([{'status': 200, 'body': {'success': True}}], site_status=flags)
            self.assertTrue(result['ok'])
            self.assertEqual(mocks['inpage_checkin'].await_args.args[2], None)
            mocks['read_site_status'].assert_not_awaited()
            mocks['wait_any_token'].assert_not_awaited()
            mocks['selfmounted_captcha_checkin'].assert_not_awaited()
            self.assertEqual(page.evaluations, [])

    async def test_turnstile_refusal_then_token_retry(self):
        for refusal in [{'message': 'Turnstile token 为空'}, {'message': 'Turnstile 校验失败'}, {'code': 'TURNSTILE_REQUIRED'}]:
            result, page, mocks = await self.run_case([
                {'status': 200, 'body': {'success': False, **refusal}},
                {'status': 200, 'body': {'success': True}},
            ])
            self.assertTrue(result['ok'])
            self.assertEqual([c.args[2] for c in mocks['inpage_checkin'].await_args_list], [None, 'fresh-token'])
            mocks['wait_any_token'].assert_awaited_once()
            mocks['selfmounted_captcha_checkin'].assert_not_awaited()
            self.assertTrue(page.evaluations)

    async def test_non_captcha_errors_skip_widgets(self):
        for status, msg in [(401, 'Unauthorized'), (429, 'Too many requests'), (503, 'Unavailable'), (200, '余额不足')]:
            result, page, mocks = await self.run_case([{'status': status, 'body': {'success': False, 'message': msg}}])
            self.assertFalse(result['ok'])
            self.assertEqual(mocks['inpage_checkin'].await_count, 1)
            mocks['wait_any_token'].assert_not_awaited()
            mocks['read_site_status'].assert_not_awaited()
            self.assertEqual(page.evaluations, [])

    async def test_known_checked_in_does_not_post(self):
        result, _, mocks = await self.run_case([], already=True)
        self.assertTrue(result['ok'])
        mocks['inpage_checkin'].assert_not_awaited()

    async def test_post_already_checked_in_does_not_retry(self):
        result, _, mocks = await self.run_case([{'status': 200, 'body': {'success': False, 'message': '今日已签到'}}])
        self.assertTrue(result['ok'])
        self.assertEqual(mocks['inpage_checkin'].await_count, 1)
        mocks['wait_any_token'].assert_not_awaited()

    async def test_real_other_captcha_keeps_existing_handlers(self):
        for msg, handler in [('人机验证 token 为空', 'selfmounted_captcha_checkin'),
                             ('reCAPTCHA required', 'recaptcha_site_ui_checkin'),
                             ('请输入验证码', 'captcha_checkin')]:
            result, _, mocks = await self.run_case([{'status': 200, 'body': {'success': False, 'message': msg}}])
            self.assertTrue(result['ok'])
            mocks[handler].assert_awaited_once()
            self.assertEqual(mocks['inpage_checkin'].await_count, 1)

    async def test_turnstile_named_captcha_does_not_request_image(self):
        for flags in [{'turnstile_check': True}, {'checkin_turnstile_check': True}]:
            result, _, mocks = await self.run_case([
                {'status': 200, 'body': {'success': False, 'message': 'Turnstile 验证码不能为空'}},
                {'status': 200, 'body': {'success': True}},
            ], site_status=flags, options={'captchaCheckin': False})
            self.assertTrue(result['ok'])
            mocks['captcha_checkin'].assert_not_awaited()
            self.assertEqual(mocks['inpage_checkin'].await_args_list[0].args[2], None)
            if flags.get('checkin_turnstile_check'):
                mocks['selfmounted_captcha_checkin'].assert_awaited_once()
            else:
                mocks['wait_any_token'].assert_awaited_once()

    async def test_generic_human_refusal_preserves_configured_recaptcha(self):
        result, _, mocks = await self.run_case([
            {'status': 200, 'body': {'success': False, 'message': '人机验证 token 为空'}},
        ], options={'recaptchaSiteKey': 'recaptcha-fixture'})
        self.assertTrue(result['ok'])
        mocks['recaptcha_site_ui_checkin'].assert_awaited_once()
        mocks['selfmounted_captcha_checkin'].assert_not_awaited()


if __name__ == '__main__':
    unittest.main()

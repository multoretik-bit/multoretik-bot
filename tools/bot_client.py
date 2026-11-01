"""Клиент RETIKO → МультоРетик Бот.

reserve(job_id, channel, title='') -> '48213'   при сборке видео: код серии (тот же код при повторе)
publish(job_id, title, yt_url, vk_url, rt_url, thumb_url, published_at) -> код   после выкладки

Настройки — RETIKO config.json → "multoretik_bot": {"api": "https://<ref>.supabase.co/functions/v1/bot",
"publish_key": "...", "bot": "имя_бота", "channels": [...]}
Сбой бота никогда не должен ронять ролик: вызывающий код ловит исключения и идёт дальше.
"""
import json
import urllib.request


def _post(cfg, action, video):
    body = json.dumps({'action': action, 'key': cfg['publish_key'], 'video': video}).encode()
    req = urllib.request.Request(cfg['api'], data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read().decode())
    if not res.get('ok'):
        raise RuntimeError('МультоРетик Бот: %s' % res.get('error'))
    return res


def reserve(cfg, job_id, channel, title=''):
    return _post(cfg, 'reserve', {'id': job_id, 'channel': channel, 'title': title})['code']


def publish(cfg, job_id, title, yt_url=None, vk_url=None, rt_url=None, thumb_url=None, published_at=None):
    return _post(cfg, 'publish', {'id': job_id, 'title': title, 'yt_url': yt_url, 'vk_url': vk_url, 'rt_url': rt_url,
                                  'thumb_url': thumb_url, 'published_at': published_at})['code']

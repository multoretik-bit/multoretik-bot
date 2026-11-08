"""Выкладка edge function bot через Management API (заодно сбрасывает кэш карточек)."""
import json, os, urllib.request, uuid
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = json.load(open(os.path.join(ROOT, 'secrets.local.json'), encoding='utf-8'))
src = open(os.path.join(ROOT, 'supabase', 'functions', 'bot', 'index.ts'), 'rb').read()
b = uuid.uuid4().hex
meta = json.dumps(dict(name='bot', entrypoint_path='index.ts', verify_jwt=False)).encode()
body = b''.join((b'--', b.encode(), b'\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n', meta, b'\r\n--', b.encode(),
                 b'\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n', src, b'\r\n--', b.encode(), b'--\r\n'))
r = urllib.request.Request('https://api.supabase.com/v1/projects/%s/functions/deploy?slug=bot' % s['supabase_ref'], body,
                           {'Authorization': 'Bearer ' + s['supabase_pat'], 'Content-Type': 'multipart/form-data; boundary=' + b, 'User-Agent': 'multoretik-tools'})
d = json.load(urllib.request.urlopen(r, timeout=120))
print('функция', d.get('slug'), 'версия', d.get('version'), d.get('status'))

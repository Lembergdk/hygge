#!/usr/bin/env python3
"""Local-only fictional HTTP fixture. Run with --settings-preview --email-ui-fixture.
No mail is sent; requests to /tracking indicate a reader isolation failure.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse
import json

ID = '11111111-1111-4111-8111-111111111111'
messages = [dict(id=ID, title='A message about your café project', sender='Jane <jane@client.example>', senderEmail='jane@client.example', senderDomain='client.example', subject='Re: Branding for our café — availability next week?', date='2026-11-04T18:00:00Z', kind='other', summary='Jane asks about your availability, timeline and project rate.', actionableItems=[], attachments=[], hasOriginal=True), dict(id='22222222-2222-4222-8222-222222222222', title=None, sender='Jobs <jobs@upwork.com>', senderEmail='jobs@upwork.com', senderDomain='upwork.com', subject='Your design jobs digest', date='2026-11-03T16:00:00Z', kind='other', summary='An older saved digest without a retained original.', actionableItems=[], attachments=[], hasOriginal=False)]
addresses = [dict(address='me@example.com', verified=True, source='account'), dict(address='work@example.com', verified=False, source='added')]
original = dict(from_='Jane <jane@client.example>', to='0123456789@usehygge.cc', subject=messages[0]['subject'], date=messages[0]['date'], text='Hi Mikael,\n\nWe loved the café branding work in your portfolio. Are you available next week? Could you share your usual project rate and timeline?\n\nThanks,\nJane', html='<p>Hi Mikael,</p><p>We loved the café branding work in your portfolio. <b>Are you available next week?</b> Could you share your usual project rate and timeline?</p><p>Thanks,<br>Jane</p><img src="http://127.0.0.1:8769/tracking"><script>document.body.innerText="SCRIPT EXECUTED"</script>', truncated=False)
original['from'] = original.pop('from_')
class Handler(BaseHTTPRequestHandler):
    def send(self, value, status=200):
        data=json.dumps(value).encode(); self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        path=urlparse(self.path).path
        if path=='/email/address': return self.send({'hyggeEmail':dict(address='0123456789@usehygge.cc',digits='0123456789',createdAt='2026-11-02T12:00:00Z')})
        if path=='/email/messages': return self.send(dict(messages=messages,senderRules=[],nextCursor=None))
        if path.endswith('/original'): return self.send(dict(original=original if ID in path else None))
        if path=='/email/addresses': return self.send(dict(addresses=addresses))
        if path=='/tracking': print('TRACKING_REQUEST_FAILED_ISOLATION',flush=True)
        self.send({'error':'fixture route missing'},404)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if self.path=='/email/addresses':
            return self.send(dict(address=body['address'],verified=False,source='added',verificationSubject='Hygge verify 0123456789abcdef0123456789abcdef'))
        if self.path.endswith('/me'):
            messages[0]['markedAsMe']=body.get('marked',True)
            return self.send(dict(marked=messages[0]['markedAsMe'],ownerAddress=dict(address=messages[0]['senderEmail'],verified=False,source='added',verificationSubject='Hygge verify 0123456789abcdef0123456789abcdef')))
        if self.path=='/email/decision': return self.send(dict(remembered=True))
        self.send({},404)
print('Fictional receive-email fixture listening on 127.0.0.1:8769',flush=True)
HTTPServer(('127.0.0.1',8769),Handler).serve_forever()

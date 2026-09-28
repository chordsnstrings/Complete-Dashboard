/* THE SMS GATEWAY, AS IT WAS MEASURED — against a fake that behaves like it.
   ═════════════════════════════════════════════════════════════════════════
   docs/COVERAGE.md "SMSala (SMS)" records what one live test on 2026-09-28
   established. Each rule below is one of those facts:

     1. a UAE mobile reaches the gateway as 9715XXXXXXXX, from the four ways
        the fleet's records write one — and nothing is padded or truncated;
     2. the send body is a JSON ARRAY (a bare object was a 400);
     3. a refusal arrives as HTTP 200 {IsSuccess:false, ErrorCode:43} and must
        read as a refusal;
     4. the 19-digit MessageId survives as text (JSON.parse rounds it);
     5. nothing is sent without a token, and a delivery report never hands
        back the message text.

   REVERSION: send `body[0]` instead of `body` — check 2 fails; read the id
   with JSON.parse — check 4 fails; drop the Array.isArray branch — check 3
   reads as success. All of these were proved by hand when this was written. */
import { uaeMobile, maskPhone, encodingFor, sendSms, deliveryReport, MESSAGE_TYPE } from '../src/smsala.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\n1. a UAE mobile, from the ways the records write one');
const same = '971501234567';
for (const raw of ['0501234567', '+971501234567', '00971501234567', '971501234567', '050 123 4567', '+971-50-123-4567', '(050) 1234567']) {
  check(`${raw} → 9715…`, uaeMobile(raw) === same, String(uaeMobile(raw)));
}
for (const raw of ['501234567', '97150123456', '9715012345678', '971301234567', '+973 3312 3456', '+44 7700 900123',
  '0501234567x', '', null, 'call me']) {
  check(`${JSON.stringify(raw)} is refused, never padded or cut`, uaeMobile(raw) === null, String(uaeMobile(raw)));
}
check('every UAE mobile range: 50 52 54 55 56 58', ['50', '52', '54', '55', '56', '58'].every((p) => uaeMobile(`0${p}1234567`)))
check('…and not 51 or 57', !uaeMobile('0511234567') && !uaeMobile('0571234567'));
check('a masked number keeps the last two digits only', maskPhone(same) === '•••••••••67' && !maskPhone(same).includes('5012'));
check('English goes as GSM, Arabic as UCS-2', encodingFor('Please register your trip from Al Garhoud to Deira - 12 km') === '0'
  && encodingFor('دبي مارينا') === '8');

console.log('\n2–4. the send, against a gateway that behaves like SMSala');
const calls = [];
const gateway = (answer) => async (url, init) => {
  calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
  return { status: answer.status ?? 200, text: async () => answer.raw };
};
const OK_RAW = '[{"MessageId":2026092810584614800,"OperationCode":0,"Status":"Success","DlrStatus":null,'
  + '"UserReferenceId":"fm-1","DestinationAddress":"971501234567","Remarks":"Message Submitted"}]';
let r = await sendSms({ to: '050 123 4567', text: 'Your code is 000000.', type: 'otp', ref: 'fm-1',
  token: 'test-token', sender: 'ECOSINE', base: 'https://gw.example.test', fetchImpl: gateway({ raw: OK_RAW }) });
const c0 = calls[0];
check('the body is a JSON array of one message', Array.isArray(c0.body) && c0.body.length === 1, JSON.stringify(c0.body).slice(0, 80));
check('…POSTed to /SendSmsV2', c0.url === 'https://gw.example.test/SendSmsV2' && c0.init.method === 'POST');
check('…to 9715…, from the sender, as type 3 for a code', c0.body[0].destinationAddress === same
  && c0.body[0].sourceAddress === 'ECOSINE' && c0.body[0].messageType === MESSAGE_TYPE.otp);
check('a submitted message is ok', r.ok === true, JSON.stringify(r));
check('the 19-digit id survives as text', r.messageId === '2026092810584614800', String(r.messageId));
check('…which JSON.parse would have rounded', String(JSON.parse(OK_RAW)[0].MessageId) !== '2026092810584614800');

r = await sendSms({ to: same, text: 'x', token: 't', base: 'https://gw.example.test',
  fetchImpl: gateway({ raw: '{"IsSuccess":false,"ErrorCode":43,"ErrorDescription":"IpAddress Not Allowed","ReturnData":null}' }) });
check('HTTP 200 with IsSuccess:false and error 43 is a refusal', r.ok === false && r.error === 'refused_43' && /IpAddress/.test(r.detail), JSON.stringify(r));
r = await sendSms({ to: same, text: 'x', token: 't', base: 'https://gw.example.test',
  fetchImpl: gateway({ status: 400, raw: '{"errors":{"apiToken":["requires a JSON array"]},"title":"One or more validation errors occurred.","status":400}' }) });
check('a 400 validation answer is a refusal with its reason', r.ok === false && r.error === 'refused_400' && /validation/.test(r.detail), JSON.stringify(r));
r = await sendSms({ to: same, text: 'x', token: 't', base: 'https://gw.example.test',
  fetchImpl: gateway({ raw: '[{"MessageId":0,"OperationCode":7,"Status":"Failed","Remarks":"Insufficient balance"}]' }) });
check('a message the gateway did not submit is not ok, and says why', r.ok === false && r.error === 'not_submitted' && /balance/.test(r.detail));
r = await sendSms({ to: same, text: 'x', token: 't', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
check('an unreachable gateway is a failure, not a throw', r.ok === false && r.error === 'unreachable');

console.log('\n5. nothing without a token or a number; the report drops the text');
const before = calls.length;
r = await sendSms({ to: same, text: 'x', token: '', fetchImpl: gateway({ raw: OK_RAW }) });
check('no token: nothing is sent', r.ok === false && r.error === 'not_configured' && calls.length === before);
r = await sendSms({ to: '+44 7700 900123', text: 'x', token: 't', fetchImpl: gateway({ raw: OK_RAW }) });
check('a number that is not a UAE mobile: nothing is sent', r.ok === false && r.error === 'bad_number' && calls.length === before);
const DLR = '{"IsSuccess":true,"ErrorCode":0,"ErrorDescription":"OK","ReturnData":[{"MessageId":2026092810584614800,'
  + '"TextReceived":"Your code is 383363.","DlrStatus":"Delivered","SentDateTime":"2026-09-28T10:58:48","CustomerCost":0.095,"MessageParts":1}]}';
const d = await deliveryReport('2026092810584614800', { token: 't', base: 'https://gw.example.test', fetchImpl: gateway({ raw: DLR }) });
check('a delivery report reads the status word, the time and the cost', d.ok && d.status === 'Delivered' && d.cost === 0.095 && d.sentAt === '2026-09-28T10:58:48');
check('…and never hands back the message text (it carries the code)', !JSON.stringify(d).includes('383363'));
const empty = await deliveryReport('1', { token: 't', base: 'https://gw.example.test', fetchImpl: gateway({ raw: '' }) });
check('an empty report is "ask again", not a failure of the message', empty.ok === false && empty.error === 'empty');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

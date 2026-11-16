/* The analyst's model, on ModelArk with thinking switched off (2026-11-16).
   ─────────────────────────────────────────────────────────────────────────
   MiniMax refused every pass from 2026-11-11 23:10Z (402, "Token Plan usage
   limit reached"). ModelArk had been the analyst's endpoint before, and every
   pass timed out there (242 s: 120 s twice) — the model reasoning before it
   answered. Both providers take {thinking: {type: 'disabled'}}; the request
   now sends it to either, and production's real brief came back in 17-25 s
   on DeepSeek V4 Pro, its GA build and Seed 2.0 Pro.

     1. thinkingSwitch: the two providers' hosts, matched on the HOSTNAME —
        a path that happens to contain one is not the provider;
     2. proposeBody: the switch rides the analyst's request for ModelArk and
        MiniMax, and stays off a host that does not understand it;
     3. config.analystModel: ModelArk by default, and ARK_API_KEY — the key
        already on both components — serves when ANALYST_API_KEY is unset;
     4. credmodel.js (the paste box's model) asks the same switch.

   REVERSIONS (each run, each failing as named):
     · bytepluses.com out of thinkingSwitch's list → §1 and §2 fail
     · proposeBody's spread back to /minimax/ alone → §2 "ModelArk" fails
     · the substring test it replaced (/bytepluses\.com/ over the whole URL)
       → §1 "a path is not the provider" fails                              */
import { readFileSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name} ${info}`); }
};

for (const k of ['ANALYST_BASE_URL', 'ANALYST_MODEL', 'ANALYST_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL', 'ARK_API_KEY']) delete process.env[k];
const { config, thinkingSwitch } = await import('../src/config.js');
const { proposeBody } = await import('../src/analyst.js');

console.log('\n1. thinkingSwitch');
{
  const yes = ['https://ark.ap-southeast.bytepluses.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3',
    'https://api.minimax.io/v1', 'https://minimax.io/v1'];
  const no = ['https://api.openai.com/v1', 'http://127.0.0.1:9/bytepluses.com/api/v3', 'https://evilbytepluses.com/v3', '', null, 'not a url'];
  check('ModelArk (both regions) and MiniMax take the switch', yes.every(thinkingSwitch), yes.filter((u) => !thinkingSwitch(u)).join(' '));
  check('…and nothing else does — a path is not the provider, nor a lookalike host', no.every((u) => !thinkingSwitch(u)),
    no.filter(thinkingSwitch).join(' '));
}

console.log('\n2. the analyst\'s request');
{
  const brief = { window: { from: '2026-10-17', to: '2026-11-15' } };
  const ark = proposeBody('PROMPT', brief, { baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: 'deepseek-v4-pro-ga-260813' });
  check('ModelArk: thinking disabled, the model and the brief as sent', ark.thinking?.type === 'disabled'
    && ark.model === 'deepseek-v4-pro-ga-260813' && ark.messages[1].content === JSON.stringify(brief) && ark.max_tokens === 3000,
    JSON.stringify(ark).slice(0, 200));
  const mm = proposeBody('PROMPT', brief, { baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3' });
  check('MiniMax: still disabled', mm.thinking?.type === 'disabled');
  const other = proposeBody('PROMPT', brief, { baseUrl: 'https://api.example.com/v1', model: 'm' });
  check('an endpoint that does not understand it is not sent it', !('thinking' in other), JSON.stringify(other).slice(0, 160));
}

console.log('\n3. config.analystModel');
{
  check('ModelArk by default', config.analystModel.baseUrl === 'https://ark.ap-southeast.bytepluses.com/api/v3', config.analystModel.baseUrl);
  check('…with a ModelArk model by default', /^(deepseek|seed)-/.test(config.analystModel.model), config.analystModel.model);
  process.env.ARK_API_KEY = 'ark-test-key';
  check('ARK_API_KEY serves when ANALYST_API_KEY is unset', config.analystModel.apiKey === 'ark-test-key');
  process.env.ANALYST_API_KEY = 'analyst-test-key';
  check('…and ANALYST_API_KEY still wins when set', config.analystModel.apiKey === 'analyst-test-key');
  delete process.env.ANALYST_API_KEY; delete process.env.ARK_API_KEY;
}

console.log('\n4. the paste box\'s model asks the same switch');
{
  const src = readFileSync(new URL('../src/credmodel.js', import.meta.url), 'utf8');
  check('credmodel.js sends the switch through thinkingSwitch, not its own list',
    /\.\.\.\(thinkingSwitch\(baseUrl\) \? \{ thinking: \{ type: 'disabled' \} \} : \{\}\)/.test(src) && !/\/minimax\/i\.test\(baseUrl/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

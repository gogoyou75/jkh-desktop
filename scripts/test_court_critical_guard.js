const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/critical_guard.js'), 'utf8');
const checkSource = source.slice(source.indexOf('  function check() {'), source.indexOf('  if (!isDevMode()) return;'));
function script(src, extra = {}) { return { type: '', async: false, defer: false, getAttribute: key => key === 'src' ? src : '', ...extra }; }
const chain = () => ['auth.js', 'storage.js?v=test', 'data.js', 'calc_engine.js', 'spravka_sud.js'].map(src => script(src));
function run(scripts, APIs = true, pathname = '/spravka_sud.html') {
  const stopped = [];
  const window = { location: { pathname, href: 'http://127.0.0.1:8080' + pathname }, JKHStore: APIs ? { getRaw() {} } : null, Data: APIs ? { readPaymentLedger() {} } : null };
  const document = { getElementsByTagName: () => scripts };
  const check = new Function('window', 'document', 'console', 'navigator', 'writeLog', 'showBanner', 'autoSnapshotPanel', 'hardStop', 'nowIso', checkSource + ';return check;')(
    window, document, { error() {} }, { userAgent: 'isolated-test' }, () => {}, () => ({}), () => {}, messages => stopped.push(...messages), () => 'test');
  check(); return stopped;
}
assert.deepEqual(run(chain()), [], 'classic server-first report must load');
let scripts = chain(); scripts[1].type = 'module'; assert(run(scripts).some(x => x.includes('ES-modules')));
scripts = chain(); scripts[1].async = true; assert(run(scripts).length);
scripts = chain(); scripts[1].defer = true; assert(run(scripts).length);
scripts = chain(); [scripts[1], scripts[2]] = [scripts[2], scripts[1]]; assert(run(scripts).length);
scripts = chain(); [scripts[3], scripts[4]] = [scripts[4], scripts[3]]; assert(run(scripts).length);
scripts = chain(); scripts.push(script('storage.js')); assert(run(scripts).length);
assert(run(chain(), false).length, 'unavailable read API must block');
assert(run(chain().filter((_, i) => i !== 0)).length, 'missing auth must block');
assert.deepEqual(run(chain().filter((_, i) => i !== 1)), [], 'legacy page without storage retains its existing guard behavior');
scripts = [script('payment_table.js'), script('calc_engine.js')]; assert(run(scripts, true, '/abonent_card.html').length);
console.log('court critical guard regression tests passed');

const reportSource = fs.readFileSync(path.join(__dirname, '../web/spravka_sud.js'), 'utf8');
const refreshSource = reportSource.slice(reportSource.indexOf('  function refreshReadOwnerAfterInit('), reportSource.indexOf('  function normalizeDbRoot('));
const refresh = new Function('getContext', refreshSource + ';return refreshReadOwnerAfterInit;')(() => ({ currentOwner: 'codex-user' }));
assert.equal(refresh({ currentOwner: 'guest', readOwner: 'guest', forcedOwner: '' }).readOwner, 'codex-user');
assert.equal(refresh({ currentOwner: 'guest', readOwner: 'explicit-owner', forcedOwner: 'explicit-owner' }).readOwner, 'explicit-owner');
assert(reportSource.indexOf('refreshReadOwnerAfterInit(ctx);') > reportSource.indexOf('const gate = await waitForInit('));
console.log('court owner readiness regression tests passed');

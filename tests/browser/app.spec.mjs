import { test,expect } from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const shots='evidence/screenshots';
const wiringShots='test-results/wiring';
// Committed screenshots change only when asked: CAPTURE_EVIDENCE=1 npm run test:ui
const evidence=async(page,name,options={})=>{if(process.env.CAPTURE_EVIDENCE)await page.screenshot({path:`${shots}/${name}.png`,...options});};
async function send(page,text){await page.locator('#message').fill(text);await page.locator('#send').click();await expect(page.locator('#pending')).toBeHidden();}
async function tap(page,locator){await locator.click();await expect(page.locator('#pending')).toBeHidden();}
async function demo(page){await page.locator('.builder').evaluate(e=>e.open=true);await page.locator('#sample').click();await expect(page.locator('[data-statement="count1"]')).toContainText('8');}
test.beforeEach(async({page})=>{await page.goto('/');await expect(page.locator('#mode')).toHaveText('MOCK · NO MODEL CALLS');});
test('source stepper, text cues, value patch and local timer continuity',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await mkdir(shots,{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:wiringShots+'/01-start.png',fullPage:true});await demo(page);
 await expect(page.locator('#spoken')).toContainText('current screen');await send(page,'next');await expect(page.locator('#position')).toHaveText('2 / 4');await page.getByRole('button',{name:'Start simulation',exact:true}).click();
 await page.locator('#next').click();await expect(page.locator('#position')).toHaveText('3 / 4');await page.locator('#back').click();await expect(page.locator('.timer-status')).toHaveText('running');
 await page.locator('#pause').click();await expect(page.locator('.timer-status')).toHaveText('paused');await expect(page.locator('#next')).toBeDisabled();await page.locator('#pause').click();await expect(page.locator('.timer-status')).toHaveText('running');
 await page.getByRole('button',{name:'Simulate finish',exact:true}).click();await expect(page.locator('.timer-status')).toHaveText('done');await expect(page.locator('#position')).toHaveText('2 / 4');
 await send(page,'change value to 6');await expect(page.locator('#position')).toHaveText('2 / 4');await send(page,'next');await expect(page.locator('[data-statement="count2"]')).toContainText('6');await page.screenshot({path:wiringShots+'/02-workout-state.png',fullPage:true});expect(errors).toEqual([]);
});
test('repeated sends, interruption, reset while pending and post-reset navigation',async({page})=>{
 await page.locator('.builder').evaluate(e=>e.open=true);await page.locator('#fault').selectOption('slow');await page.locator('#message').fill('/demo');await page.locator('#send').click();await page.locator('#message').fill('/demo');await page.locator('#send').click();await expect(page.locator('.message.user')).toHaveCount(1);await page.locator('#reset').click();await page.waitForTimeout(2500);await expect(page.locator('#screen')).toContainText('Your workout starts here');await demo(page);await page.locator('#next').click();await page.locator('#reset').click();await demo(page);await page.locator('#next').click();await expect(page.locator('#position')).toHaveText('2 / 4');
 await page.locator('#fault').selectOption('slow');await page.locator('#message').fill('next');await page.locator('#send').click();await send(page,'back');await expect(page.locator('#position')).toHaveText('1 / 4');
});
for(const fault of ['schema','request'])test(`${fault} failure preserves screen and retry recovers`,async({page})=>{await demo(page);await page.locator('.builder').evaluate(e=>e.open=true);await page.locator('#fault').selectOption(fault);await send(page,'next');await expect(page.locator('#error')).toBeVisible();await expect(page.locator('[data-statement="count1"]')).toContainText('8');await page.locator('#retry').click();await expect(page.locator('#position')).toHaveText('2 / 4');await expect(page.locator('#error')).toBeHidden();});
test('local valid/invalid patches are data and candidate component can be registered',async({page})=>{
 await demo(page);await page.locator('.builder').evaluate(e=>e.open=true);await page.locator('#patch').fill('count1 = Keyword("<img src=x onerror=alert(1)>", "inert")');await page.locator('#apply-patch').click();await expect(page.locator('[data-statement="count1"]')).toContainText('<img src=x');await expect(page.locator('#screen img')).toHaveCount(0);
 await page.locator('#patch').fill('count1 = Function("evil")');await page.locator('#apply-patch').click();await expect(page.locator('#patch-status')).toContainText('Invalid patch');
 // Trusted test code registers a candidate component in all three local seams.
 await page.evaluate(async()=>{const {OPENUI_LIBRARY}=await import('/shared/openui/openui-library.js');const {propValidators}=await import('/shared/openui/validate.js');const {renderers}=await import('/web/components.js');OPENUI_LIBRARY.StatusPill={args:['label','value'],required:2};propValidators.StatusPill=p=>typeof p.label==='string'&&typeof p.value==='string';renderers.StatusPill=({props:p})=>{const n=document.createElement('div');n.textContent=p.label+': '+p.value;return n;};});
 await page.locator('#patch').fill('page1 = Screen([heading1, custom1])\ncustom1 = StatusPill("Sample", "A")');await page.locator('#apply-patch').click();await expect(page.locator('[data-statement="custom1"]')).toHaveText('Sample: A');
});
test('manual export contains screen/events/versions and no token; mobile fits',async({page})=>{
 await page.setViewportSize({width:390,height:844});await demo(page);await page.locator('.builder').evaluate(e=>e.open=true);await page.locator('#note').fill('Tested mock only. TOKEN=do-not-export');const download=page.waitForEvent('download');await page.locator('#export').click();const d=await download;const stream=await d.createReadStream();let content='';for await(const chunk of stream)content+=chunk;const json=JSON.parse(content);expect(json.state.ui_state).toContain('root = Screens');expect(json.events.find(e=>e.result).result.versions.protocolHash).toHaveLength(64);expect(content).not.toContain('do-not-export');expect(content).not.toContain('X-Local-Token');await page.locator('.builder').evaluate(e=>e.open=false);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:wiringShots+'/03-mobile.png',fullPage:true});
});
test('runtime starts mock; Codex blocked; selecting never calls model endpoint',async({page})=>{let turns=0;page.on('request',r=>{if(r.url().includes('/api/turn'))turns++;});await page.locator('#provider').selectOption('codex-cli');await expect(page.locator('#send')).toBeDisabled();await expect(page.locator('#provider-description')).toContainText('no-command/no-private-read');expect(turns).toBe(0);});
test('configured CLI needs explicit consent and records fake provider identity',async({page})=>{
 await page.route('**/api/config',async route=>{const response=await route.fetch();const cfg=await response.json();cfg.providers.find(p=>p.id==='claude-cli').enabled=true;await route.fulfill({json:cfg});});await page.reload();await page.locator('#provider').selectOption('claude-cli');await expect(page.locator('#send')).toBeDisabled();await page.locator('#consent').check();await page.route('**/api/turn',route=>route.fulfill({json:{turn:{reply:'Transport fixture, not a live CLI request.'},versions:{provider:'claude-cli',mode:'live',model:'fixture-only'}}}));await send(page,'hello');await expect(page.locator('#spoken')).toContainText('Transport fixture');
});
test('full 90-second workout flow: preview, adaptations and simulation to recap', async ({ page }) => {
 await page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }).click();
 await expect(page.locator('#screen')).toContainText('Session preview');
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start opening', exact: true }));
 await expect(page.locator('#screen')).toContainText('Opening warm-up');
 await page.getByRole('button', { name: 'Simulate finish', exact: true }).click();
 await expect(page.locator('#screen')).toContainText('How does this pace fit?');
 await page.locator('#screen').getByRole('button', { name: 'Make it easier', exact: true }).click();
 await expect(page.locator('#transcript')).toContainText('breathing room');
 await page.locator('#screen').getByRole('button', { name: 'I have 5 minutes left', exact: true }).click();
 await expect(page.locator('#transcript')).toContainText('5 minutes');
 await page.locator('#btn-sim-remaining').click();
 await expect(page.locator('#screen')).toContainText('Session complete');
 await expect(page.locator('#screen')).toContainText('Simulated time completed');
 await expect(page.locator('#screen')).toContainText('7:00');
 await expect(page.locator('#screen')).toContainText('fast-forwarded');
 await expect(page.locator('#pending')).toBeHidden();
 await evidence(page,'04-recap',{fullPage:true});
 await expect(page.locator('#screen')).toContainText('8 intervals completed');
 await expect(page.locator('#screen')).toContainText('10 intervals removed');
 const state = JSON.parse(await page.locator('#state-json').textContent());
 expect(state.workout.intervals.filter(i => i.status === 'completed')).toHaveLength(8);
 expect(state.workout.intervals.filter(i => i.status === 'removed')).toHaveLength(10);
 expect(state.workout.intervals.filter(i => i.status === 'active')).toHaveLength(0);
 expect(state.workout.intervals.filter(i => i.status === 'pending')).toHaveLength(0);
});
test('on-screen buttons alone move from a work slot through recovery to the next check-in', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 const finish = () => tap(page, button('Simulate finish'));
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await tap(page, button('Start opening'));
 await finish();
 await tap(page, button('Continue next slot'));
 await expect(page.locator('#screen')).toContainText('Slot 1: Tempo squat');
 await evidence(page,'02-active-slot',{fullPage:true});
 await finish();
 await expect(page.locator('#screen')).toContainText('Slot 1: Recovery');
 const state = JSON.parse(await page.locator('#state-json').textContent());
 expect(state.workout.activeIntervalId).toBe('slot-1-rest');
 expect(state.timers.find(t => t.id === 'timer_slot_1_rest').status).toBe('running');
 await finish();
 await expect(page.locator('#screen')).toContainText('How does this pace fit?');
 await expect(page.locator('#screen')).toContainText('Slot 2: Standing reach');
 await tap(page, button('Make it easier'));
 await expect(page.locator('#screen')).toContainText('(25s)');
 await evidence(page,'03-checkin-eased',{fullPage:true});
});
test('a typed request is adapted through the coach Proposal, not a local shortcut', async ({ page }) => {
 await page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }).click();
 await send(page, 'Can you shorten it?');
 await expect(page.locator('#transcript')).toContainText('How many minutes');
 let state = JSON.parse(await page.locator('#state-json').textContent());
 expect(state.workout.adaptationHistory).toHaveLength(0);
 await send(page, 'I only have 4 minutes left');
 await expect(page.locator('#transcript')).toContainText('Adaptation applied');
 state = JSON.parse(await page.locator('#state-json').textContent());
 expect(state.workout.adaptationHistory.map(a => a.intent)).toEqual(['shorten']);
 expect(state.workout.actionHistory.at(-1)).toMatchObject({ action: 'adaptation', source: 'model' });
});
test('workout preview and active slot fit a phone screen', async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await expect(page.locator('#screen')).toContainText('Session preview');
 await evidence(page,'01-preview',{fullPage:false});
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start opening', exact: true }));
 await expect(page.locator('#screen')).toContainText('Warm-up');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await evidence(page,'05-mobile-active',{fullPage:true});
});
test('remaining planned time counts down with the running interval timer', async ({ page }) => {
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start opening', exact: true }));
 const remaining = page.locator('[data-statement="remainingStat"] strong');
 await expect(remaining).toHaveText('12:00');
 await expect(remaining).not.toHaveText('12:00', { timeout: 4000 });
 const [total, clock] = await page.evaluate(() => [document.querySelector('[data-statement="remainingStat"] strong').textContent, document.querySelector('.timer strong').textContent]);
 const secs = t => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
 expect(secs(total) - secs(clock)).toBe(600);
});
test('typed text never runs a session command, even when it names one', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await tap(page, button('Start opening'));
 await tap(page, button('Simulate finish'));
 await send(page, 'do not end session yet');
 const state = JSON.parse(await page.locator('#state-json').textContent());
 expect(state.workout.stage).toBe('checkin');
 await expect(page.locator('#screen')).toContainText('How does this pace fit?');
});
test('workout buttons work without an available provider and send nothing', async ({ page }) => {
 let turns = 0; page.on('request', r => { if (r.url().includes('/api/turn')) turns++; });
 await page.locator('#provider').selectOption('claude-cli');
 await page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }).click();
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await button('Start opening').click();
 await button('Simulate finish').click();
 await button('End session').click();
 await expect(page.locator('#screen')).toContainText('Session ended early');
 await expect(page.locator('#error')).toBeHidden();
 expect(turns).toBe(0);
});
test('a proposal from before the session moved on is not applied', async ({ page }) => {
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start opening', exact: true }));
 await page.locator('.builder').evaluate(e => e.open = true);
 await page.locator('#fault').selectOption('slow');
 await page.locator('#message').fill('please make it gentler');
 await page.locator('#send').click();
 await expect(page.locator('#pending')).toBeVisible();
 await page.getByRole('button', { name: 'Simulate finish', exact: true }).click();
 await expect(page.locator('#screen')).toContainText('How does this pace fit?');
 await expect(page.locator('#pending')).toBeHidden({ timeout: 10000 });
 await expect(page.locator('#transcript')).toContainText('Coach proposal not applied');
 const state = JSON.parse(await page.locator('#state-json').textContent());
 expect(state.workout.adaptationHistory).toHaveLength(0);
});
test('builder patches cannot overwrite the workout screen', async ({ page }) => {
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await page.locator('.builder').evaluate(e => e.open = true);
 await page.locator('#patch').fill('remainingStat = Keyword("99:00", "Remaining planned time")');
 await page.locator('#apply-patch').click();
 await expect(page.locator('#patch-status')).toContainText('Patches are for the wiring sample');
 await expect(page.locator('#screen')).not.toContainText('99:00');
});
test('action history records automatic recovery starts and how each interval ended', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await tap(page, button('Start opening'));
 await tap(page, button('Simulate finish'));
 await tap(page, button('Continue next slot'));
 await page.getByRole('button', { name: 'Simulate finish', exact: true }).click();
 await expect(page.locator('#screen')).toContainText('Slot 1: Recovery');
 const history = JSON.parse(await page.locator('#state-json').textContent()).workout.actionHistory;
 expect(history).toContainEqual(expect.objectContaining({ action: 'complete-interval', intervalId: 'slot-1-work', source: 'user' }));
 expect(history).toContainEqual(expect.objectContaining({ action: 'start-interval', intervalId: 'slot-1-rest', source: 'auto' }));
});
test('a wiring-only export carries no workout data', async ({ page }) => {
 await demo(page);
 const download = page.waitForEvent('download');
 await page.locator('#export').click();
 let content = ''; for await (const chunk of await (await download).createReadStream()) content += chunk;
 const json = JSON.parse(content);
 expect(json.workout).toBeUndefined();
 expect(json.recap).toBeUndefined();
});
test('pressing an option while the coach is replying does not cancel the typed question', async ({ page }) => {
 let turns = 0; page.on('request', r => { if (r.url().includes('/api/turn')) turns++; });
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await tap(page, button('Start opening'));
 await tap(page, button('Simulate finish'));
 const before = turns;
 await page.locator('.builder').evaluate(e => e.open = true);
 await page.locator('#fault').selectOption('slow');
 await page.locator('#message').fill('please make it gentler');
 await page.locator('#send').click();
 await expect(page.locator('#pending')).toBeVisible();
 await button('Continue next slot').click();
 await expect(page.locator('#screen')).toContainText('Main slot 1 of 8 · Work');
 await expect(page.locator('#pending')).toBeHidden({ timeout: 10000 });
 await expect(page.locator('#transcript')).not.toContainText('Previous reply interrupted');
 await expect(page.locator('#transcript')).toContainText('Coach proposal not applied');
 expect(turns - before).toBe(1);
});
test('preview steps are numbered and recap items keep their markers', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await expect(page.locator('#screen ol li')).toHaveCount(3);
 await tap(page, button('Start opening'));
 await tap(page, button('End session'));
 await expect(page.locator('#screen li[data-marker="plus"]')).toHaveCount(1);
 await expect(page.locator('#screen li[data-marker="minus"]')).toHaveCount(1);
});
test('the transcript logs a finished interval before the recovery it starts', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await tap(page, button('Start opening'));
 await tap(page, button('Simulate finish'));
 await tap(page, button('Continue next slot'));
 await tap(page, button('Simulate finish'));
 const events = await page.locator('#transcript .event').allTextContents();
 const finished = events.indexOf('The timer for Slot 1: Tempo squat finished.');
 const started = events.findIndex(e => e.startsWith('Started a timer for Slot 1: Recovery'));
 expect(finished).toBeGreaterThan(-1);
 expect(started).toBeGreaterThan(finished);
});
test('a newer option press replaces a stale comment on an older one', async ({ page }) => {
 const sent = [];
 await page.route('**/api/turn', async route => {
  const text = JSON.parse(route.request().postData()).messages.at(-1).content;
  sent.push(text);
  if (text === 'Start opening') await new Promise(r => setTimeout(r, 2500));
  try { await route.continue(); } catch {}
 });
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await button('Start opening').click();
 await expect(page.locator('#pending')).toBeVisible();
 await button('Simulate finish').click();
 await button('Continue next slot').click();
 await expect(page.locator('#pending')).toBeHidden({ timeout: 10000 });
 expect(sent).toContain('Continue next slot');
 await expect(page.locator('#transcript')).not.toContainText('Opening warm-up is under way');
 await expect(page.locator('#transcript')).toContainText('Slot 1: Tempo squat is under way');
});
async function toFirstEffortCheckin(page) {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await tap(page, button('Start opening'));
 await tap(page, button('Simulate finish'));
 await tap(page, button('Continue next slot'));
 await tap(page, button('Simulate finish'));
 await tap(page, button('Simulate finish'));
 await expect(page.locator('#screen')).toContainText('How hard was slot 1?');
 return button;
}
test('an effort rating leads to a coach suggestion that applies only when accepted', async ({ page }) => {
 const button = await toFirstEffortCheckin(page);
 await tap(page, button('Effort 5 · very hard'));
 await expect(page.locator('#screen')).toContainText('Coach suggests more recovery');
 await evidence(page,'07-effort-suggestion',{fullPage:true});
 let state = JSON.parse(await page.locator('#state-json').textContent()).workout;
 expect(state.profile).toBe('steady');
 expect(state.efforts.map(e => e.score)).toEqual([5]);
 await tap(page, button('Apply suggestion'));
 state = JSON.parse(await page.locator('#state-json').textContent()).workout;
 expect(state.profile).toBe('low-energy');
 expect(state.adaptationHistory).toHaveLength(1);
 expect(state.actionHistory.at(-1).details).toMatch(/^Accepted coach suggestion/);
 await expect(page.locator('#screen')).not.toContainText('Coach suggests');
});
test('declining a suggestion leaves the plan unchanged', async ({ page }) => {
 const button = await toFirstEffortCheckin(page);
 await tap(page, button('Effort 1 · very easy'));
 await expect(page.locator('#screen')).toContainText('Coach suggests a stronger pace');
 await tap(page, button('Not now'));
 const state = JSON.parse(await page.locator('#state-json').textContent()).workout;
 expect(state.profile).toBe('steady');
 expect(state.adaptationHistory).toHaveLength(0);
 await expect(page.locator('#screen')).not.toContainText('Coach suggests');
});
test('harder and easier each move exactly one pace level', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await tap(page, button('Start opening'));
 await tap(page, button('Make it harder'));
 let state = JSON.parse(await page.locator('#state-json').textContent()).workout;
 expect(state.profile).toBe('high-energy');
 await tap(page, button('Make it easier'));
 state = JSON.parse(await page.locator('#state-json').textContent()).workout;
 expect(state.profile).toBe('steady');
 expect(state.adaptationHistory.map(a => a.intent)).toEqual(['push', 'ease']);
});
test('once a session starts, the session leads on a phone', async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start demo session', exact: true }));
 await expect(page.locator('.intro')).toBeHidden();
 const top = await page.locator('#screen').evaluate(e => e.getBoundingClientRect().top);
 expect(top).toBeLessThan(300);
 const order = await page.locator('.workspace > section').evaluateAll(s => s.map(e => e.className));
 expect(order).toEqual(['preview', 'conversation']);
});
test('the plan strip shows every interval and marks removed ones', async ({ page }) => {
 const button = name => page.locator('#screen').getByRole('button', { name, exact: true });
 await tap(page, button('Start demo session'));
 await expect(page.locator('.plan-strip span')).toHaveCount(18);
 await tap(page, button('Start opening'));
 await tap(page, button('I have 5 minutes left'));
 const removed = JSON.parse(await page.locator('#state-json').textContent()).workout.intervals.filter(i => i.status === 'removed').length;
 expect(removed).toBeGreaterThan(0);
 await expect(page.locator('.plan-strip span.removed')).toHaveCount(removed);
 await expect(page.locator('.plan-strip span.active')).toHaveCount(1);
});

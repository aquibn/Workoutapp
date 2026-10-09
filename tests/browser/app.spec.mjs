import { test,expect } from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const shots='evidence/screenshots';
const wiringShots='test-results/wiring';
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
 await page.locator('#btn-start-demo').click();
 await expect(page.locator('#screen')).toContainText('Session preview');
 await send(page, 'start opening');
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
 await mkdir(shots,{recursive:true});await page.screenshot({path:shots+'/04-recap.png',fullPage:true});
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
 const finish = () => tap(page, button('Simulate interval finish'));
 await tap(page, page.locator('#btn-start-demo'));
 await tap(page, button('Start opening'));
 await finish();
 await tap(page, button('Continue next slot'));
 await expect(page.locator('#screen')).toContainText('Slot 1: Tempo squat');
 await mkdir(shots,{recursive:true});await page.screenshot({path:shots+'/02-active-slot.png',fullPage:true});
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
 await page.screenshot({path:shots+'/03-checkin-eased.png',fullPage:true});
});
test('a typed request is adapted through the coach Proposal, not a local shortcut', async ({ page }) => {
 await page.locator('#btn-start-demo').click();
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
 await tap(page, page.locator('#btn-start-demo'));
 await expect(page.locator('#screen')).toContainText('Session preview');
 await mkdir(shots,{recursive:true});await page.screenshot({path:shots+'/01-preview.png',fullPage:false});
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start opening', exact: true }));
 await expect(page.locator('#screen')).toContainText('Warm-up');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:shots+'/05-mobile-active.png',fullPage:true});
});
test('remaining planned time counts down with the running interval timer', async ({ page }) => {
 await tap(page, page.locator('#btn-start-demo'));
 await tap(page, page.locator('#screen').getByRole('button', { name: 'Start opening', exact: true }));
 const remaining = page.locator('[data-statement="remainingStat"] strong');
 await expect(remaining).toHaveText('12:00');
 await expect(remaining).not.toHaveText('12:00', { timeout: 4000 });
 const [total, clock] = await page.evaluate(() => [document.querySelector('[data-statement="remainingStat"] strong').textContent, document.querySelector('.timer strong').textContent]);
 const secs = t => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
 expect(secs(total) - secs(clock)).toBe(600);
});

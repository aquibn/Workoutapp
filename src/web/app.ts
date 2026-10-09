import { Conversation } from '../shared/controller.js';
import { APP_VERSION, SCHEMA_VERSION, type Provider, type ProviderStatus, type RequestData, type Result } from '../shared/contracts.js';
import { TimerLedger, type TimerListEntry } from '../shared/openui/timer-store.js';
import { activityClientEvents, timerTransitionEvent } from '../shared/openui/activity-client-events.js';
import { createRunNav } from '../shared/openui/run-nav.js';
import { splitReply } from '../shared/openui/document.js';
import type { StatementNode } from '../shared/openui/openui-model.js';
import { redactValue } from '../shared/redact.js';
import { renderComponent } from './components.js';
import { byId,el } from './dom.js';
import { applyAdaptation, calculateRemainingSeconds, completeActiveInterval, createWorkoutSession, endSession, getRecapSummary, startInterval, startSession } from '../shared/workout/session.js';
import { extractProposal, formatClock, intervalTimerKey, renderWorkoutProgram } from '../shared/workout/openui-bridge.js';
import type { WorkoutActionRecord, WorkoutSession } from '../shared/workout/types.js';

type Config={providers:ProviderStatus[];token:string};let config:Config|undefined;
const timers=new TimerLedger();let previousTimers=new Map<string,TimerListEntry>(),updates:(()=>void)[]=[],paused=false,pausedTimers:string[]=[],renderKey='',lastClear=0;
const draft=byId<HTMLTextAreaElement>('message');
const c=new Conversation(async(request:RequestData,signal:AbortSignal):Promise<Result>=>{
  const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,request.provider==='claude-cli'?85000:48000);
  try{const response=await fetch('/api/turn',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':config!.token},body:JSON.stringify(request),signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error??'Request failed.');return data;}
  catch(error){if(error instanceof Error && error.name==='AbortError')throw new Error('Request cancelled or timed out. Retry when ready.');throw error;}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
},render,()=>[...(paused?['Preview is currently paused.']:[]),...timers.list().map(t=>`Simulated timer ${t.id} (${t.label}): ${t.status}, ${Math.ceil(t.remaining)} of ${t.seconds} seconds remaining.`)],workoutSnapshot,onCoachReply);
function makeNav(){return createRunNav({index:()=>c.document.screens.findIndex(s=>s.key===c.document.cursor),stepCount:()=>c.document.screens.length,isConsumed:()=>false,awaiting:()=>false,leave:()=>{if(c.pending)c.cancel('interrupted');},land:(from,to)=>{c.document.move(to);c.localEvent(to<from?activityClientEvents.wentBack(`step ${from+1}`,`step ${to+1}`):activityClientEvents.nowOnStep(`step ${to+1} of ${c.document.screens.length}`));},phase:()=>{},finish:()=>c.localEvent('Reached the final screen. This is not evidence of physical completion.')},{outMs:30,inMs:30});}
let nav=makeNav();
function send(text:string,typed=false){if(!config)return;const provider=config.providers.find(p=>p.id===c.provider)!;if(!provider.enabled||(c.provider!=='mock'&&!c.consent)){c.error='Set up this provider and agree to usage, or select Mock.';render();return;}if(paused){c.error='Resume the preview before sending.';render();return;}const f=byId<HTMLSelectElement>('fault');const fault=f.value as RequestData['fault'];f.value='none';runWorkoutCommand(text,typed);void c.send(text,fault);}
function syncTimers(){
  if(lastClear!==c.document.clearVersion){nav.dispose();nav=makeNav();timers.forget();previousTimers.clear();lastClear=c.document.clearVersion;}
  const ids=new Set<string>();for(const s of c.document.screens)for(const node of s.props.children as StatementNode[])if(node.name==='Timer'){ids.add(node.key);timers.ensure(node.key,{label:String(node.props.label),seconds:Number(node.props.seconds)});}
  for(const t of timers.list())if(!ids.has(t.id)){timers.forget(t.id);previousTimers.delete(t.id);}
}
function tick(){const snapshot=timers.list();for(const entry of snapshot){const before=previousTimers.get(entry.id);previousTimers.set(entry.id,{...entry});if(before && before.status!=='done'&&entry.status==='done'&&!finishWorkoutTimer(entry.id))c.localEvent(activityClientEvents.finishedTimer(entry.label),false);}updates.forEach(fn=>fn());}
function timerAction(id:string,action:'start'|'pause'|'reset'|'finish'){
  const before=timers.list().find(t=>t.id===id);if(!before||paused)return;
  if(action==='finish'&&finishWorkoutTimer(id))return;
  if(action==='start')timers.start(id);if(action==='pause')timers.pause(id);if(action==='reset')timers.reset(id);if(action==='finish')timers.finish(id);
  const after=timers.list().find(t=>t.id===id)!;previousTimers.set(id,{...after});
  const event=action==='reset'?activityClientEvents.resetTimer(after.label,after.seconds):action==='start'&&before.status==='stopped'?activityClientEvents.startedTimer(after.label,after.seconds):timerTransitionEvent(before,after);
  c.localEvent(event??`Simulated ${action} for ${after.label}.`);tick();
}
function render(){
  if(config){const selected=config.providers.find(p=>p.id===c.provider)!;byId('mode').textContent=c.provider==='mock'?'MOCK · NO MODEL CALLS':selected.enabled?'LIVE WHEN SENT':'SETUP / BLOCKED';byId('provider-description').textContent=selected.message;byId('consent-wrap').hidden=c.provider==='mock'||!selected.enabled;byId('consent-label').textContent=c.provider==='claude-cli'?'Use my subscription quota on Send/Retry; I reviewed the host-policy limits.':'Use my API budget on Send/Retry.';byId<HTMLInputElement>('consent').checked=c.consent;byId<HTMLButtonElement>('send').disabled=!selected.enabled||(c.provider!=='mock'&&!c.consent)||paused;byId('mock-controls').hidden=c.provider!=='mock';byId('sample').hidden=c.provider!=='mock';}
  byId('send').textContent=c.pending?'Send update ↗':'Send ↗';byId<HTMLButtonElement>('cancel').disabled=!c.pending;byId('pending').hidden=!c.pending;byId('status').textContent=c.pending?'Thinking… type an update to interrupt':c.error?'Needs attention':'Ready when you are';byId('error').hidden=!c.error;byId('error-message').textContent=c.error;
  const transcript=byId('transcript');transcript.replaceChildren();if(!c.events.length)transcript.append(el('p','Start the demo session, then tell the coach how it is going.','micro'));
  for(const event of c.events){if(event.kind==='input'||event.kind==='response'){const n=el('div','','message '+(event.kind==='input'?'user':'assistant'));n.append(el('span',event.kind==='input'?'You':'Reply','who'),el('p',event.text??splitReply(event.result!.turn.reply).prose??''));transcript.append(n);}else if(event.text)transcript.append(el('p',event.text,'event'));else if(event.kind==='interrupted'||event.kind==='cancelled')transcript.append(el('p',event.kind==='interrupted'?'Previous reply interrupted. Your messages are kept.':'Reply cancelled.','event'));}
  transcript.scrollTop=transcript.scrollHeight;syncTimers();
  const screens=c.document.screens,index=screens.findIndex(s=>s.key===c.document.cursor),key=c.document.echo()+String(paused);
  if(key!==renderKey || !byId('screen').childNodes.length){renderKey=key;updates=[];const surface=byId('screen');surface.replaceChildren();const current=c.document.current;
    if(!current){const n=el('div','','empty');n.append(el('p','AiRA · FIND YOUR PACE','eyebrow'),el('h3','Your workout starts here.'),el('p','Click Start demo session to begin.'));surface.append(n);}
    else{for(const node of current.props.children as StatementNode[])if(node.name!=='Cue')surface.append(renderComponent(node,{send,timers,timerAction,updates,paused}));if(workoutActive)watchRemaining(surface);}
    const progress=byId('progress');progress.replaceChildren();if(screens.length>1)for(let i=0;i<screens.length;i++){const n=el('span','',''+(i===index?'active':i<index?'past':''));n.setAttribute('aria-label',`Screen ${i+1}${i===index?', current':''}`);progress.append(n);}
  }
  byId('navigation').hidden=screens.length<2;byId('position').textContent=`${index+1} / ${screens.length}`;byId<HTMLButtonElement>('back').disabled=paused||index<=0;byId<HTMLButtonElement>('next').disabled=paused;byId('next').textContent=index===screens.length-1?'Finish preview':'Next →';
  byId<HTMLButtonElement>('pause').disabled=!screens.length;byId('pause').textContent=paused?'Resume preview':'Pause preview';byId('paused').hidden=!paused;
  const cues=(c.document.current?.props.children as StatementNode[]??[]).filter(n=>n.name==='Cue').map(n=>String(n.props.text));byId('spoken').textContent=cues.join(' ')||c.document.prose||'Current-screen Cues appear here as text. No audio is produced.';
  byId('state-json').textContent=JSON.stringify({ui_state:c.document.echo(),client_events:c.clientEvents,timers:timers.list(),workout},null,2);byId<HTMLButtonElement>('export').disabled=c.pending||!c.events.length;
  const inSession=workoutActive&&!['welcome','recap'].includes(workout.stage);byId('btn-start-demo').hidden=workoutActive;byId('btn-sim-remaining').hidden=!inSession;byId<HTMLButtonElement>('btn-sim-remaining').disabled=paused||c.pending;byId('workout-actions').hidden=workoutActive&&!inSession;
}
byId<HTMLFormElement>('composer').addEventListener('submit',event=>{event.preventDefault();const text=draft.value.trim();if(text){draft.value='';send(text,true);}});
draft.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();byId<HTMLFormElement>('composer').requestSubmit();}});
byId('sample').addEventListener('click',()=>{workoutActive=false;send('Load wiring sample');});byId('cancel').addEventListener('click',()=>c.cancel());byId('retry').addEventListener('click',()=>{if(!paused)void c.retry();});
byId('reset').addEventListener('click',()=>{nav.dispose();paused=false;pausedTimers=[];timers.forget();previousTimers.clear();draft.value='';workoutActive=false;workout=createWorkoutSession();c.reset();});
byId('back').addEventListener('click',()=>nav.back());byId('next').addEventListener('click',()=>nav.next());
byId('pause').addEventListener('click',()=>{paused=!paused;if(paused){pausedTimers=timers.list().filter(t=>t.status==='running').map(t=>t.id);for(const id of pausedTimers)timers.pause(id);}else{for(const id of pausedTimers)timers.start(id);pausedTimers=[];}c.localEvent(paused?'User paused the preview.':'User resumed the preview.');tick();});
byId<HTMLSelectElement>('provider').addEventListener('change',event=>c.selectProvider((event.target as HTMLSelectElement).value as Provider));
byId<HTMLInputElement>('consent').addEventListener('change',event=>{c.consent=(event.target as HTMLInputElement).checked;if(!c.consent)c.cancel();render();});
byId('apply-patch').addEventListener('click',()=>{try{const raw=byId<HTMLTextAreaElement>('patch').value;c.document.apply(raw.includes('```')?raw:'```openui\n'+raw+'\n```');c.localEvent('Builder applied local OpenUI data: '+raw);byId('patch-status').textContent='Patch accepted. This is local fixture evidence, not a model run.';}catch{byId('patch-status').textContent='Invalid patch. Previous screen kept. Check names, arguments and catalog.';}});
byId('export').addEventListener('click',()=>{const label=byId<HTMLSelectElement>('run-label').value;const payload={format:'aira-workout-run-v1',label,appVersion:APP_VERSION,schemaVersion:SCHEMA_VERSION,selectedProvider:c.provider,note:byId<HTMLTextAreaElement>('note').value,events:c.events,state:{ui_state:c.document.echo(),client_events:c.clientEvents},timers:timers.list(),workout,recap:getRecapSummary(workout)};const url=URL.createObjectURL(new Blob([JSON.stringify(redactValue(payload),null,2)],{type:'application/json'}));const link=el('a');link.href=url;link.download=label+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);byId('export-status').textContent=`Downloaded ${label}.json. Review and move it into runs/.`;});
byId('btn-start-demo').addEventListener('click',()=>send('Start demo session'));
byId('btn-sim-remaining').addEventListener('click',()=>{if(!paused&&!c.pending)dispatch('skip-ahead');});
async function start(){render();try{const response=await fetch('/api/config');if(!response.ok)throw new Error();config=await response.json();const select=byId<HTMLSelectElement>('provider');select.replaceChildren();for(const p of config!.providers){const option=el('option',p.label+(p.enabled?'':' · setup / blocked'));option.value=p.id;select.append(option);}select.value='mock';select.disabled=false;render();}catch{byId('status').textContent='Could not connect. Restart the local server and reload.';}}

// ---- Workout ----------------------------------------------------------------
// session.ts owns the workout. Every change re-renders the screen from it; a model
// reply contributes prose and, at most, a Proposal that is checked before it applies.

let workout: WorkoutSession = createWorkoutSession();
let workoutActive = false;
let lastSendTyped = false;
// The plan as it was when the last request went out. A Proposal is dropped if an
// adaptation or restart changed the plan while the model was replying.
let sentPlan: { sessionId: string; adaptations: number } | null = null;

type WorkoutAction = 'start-session' | 'start-interval' | 'complete-interval' | 'end-session' | 'restart' | 'ease' | 'shorten' | 'skip-ahead';

function activeRemaining(): number | undefined {
  const id = workout.activeIntervalId;
  return id ? timers.list().find(t => t.id === intervalTimerKey(id))?.remaining : undefined;
}

function record(action: WorkoutActionRecord['action'], source: WorkoutActionRecord['source'], intervalId?: string, details?: string) {
  workout = { ...workout, actionHistory: [...(workout.actionHistory ?? []), { action, intervalId, source, at: new Date().toISOString(), details }] };
}

function showWorkout(event?: string) {
  c.document.apply('```openui\n' + renderWorkoutProgram(workout, activeRemaining()) + '\n```');
  syncTimers();
  // A newly active interval arrives with a stopped timer; start it.
  const active = workout.intervals.find(i => i.id === workout.activeIntervalId);
  if (active && timers.list().find(t => t.id === intervalTimerKey(active.id))?.status === 'stopped') {
    timers.start(intervalTimerKey(active.id));
    c.localEvent(activityClientEvents.startedTimer(active.label, active.durationSeconds), false);
  }
  if (event) c.localEvent(event, false); else render();
}

function dispatch(action: WorkoutAction, arg?: string | number, source: WorkoutActionRecord['source'] = 'user') {
  if (workout.stage === 'recap' && action !== 'restart') return;
  workoutActive = true;
  const activeId = workout.activeIntervalId;

  switch (action) {
    case 'start-session':
      workout = startSession(workout);
      record(action, source);
      return showWorkout('Started workout session preview.');
    case 'start-interval':
      workout = startInterval(workout, typeof arg === 'string' ? arg : undefined);
      if (workout.activeIntervalId && workout.activeIntervalId !== activeId) record(action, source, workout.activeIntervalId);
      return showWorkout();
    case 'complete-interval': {
      if (!activeId) return;
      const { label } = workout.intervals.find(i => i.id === activeId)!;
      timers.finish(intervalTimerKey(activeId));
      workout = completeActiveInterval(workout);
      record(action, source, activeId);
      return showWorkout(activityClientEvents.finishedTimer(label));
    }
    case 'end-session':
      if (activeId) timers.finish(intervalTimerKey(activeId));
      workout = endSession(workout);
      record(action, source);
      return showWorkout('Ended session early.');
    case 'restart':
      nav.dispose(); nav = makeNav(); paused = false; pausedTimers = []; timers.forget(); previousTimers.clear();
      workout = createWorkoutSession();
      record(action, source);
      return showWorkout('Restarted demo session.');
    case 'ease':
    case 'shorten': {
      const seconds = typeof arg === 'number' ? arg : undefined;
      const result = applyAdaptation(workout, { intent: action, seconds, revision: workout.revision, sessionId: workout.sessionId }, activeRemaining());
      if (!result.applied) return render();
      workout = result.session;
      record('adaptation', source, undefined, result.summary);
      return showWorkout('Adaptation applied: ' + result.summary);
    }
    case 'skip-ahead':
      if (activeId) timers.finish(intervalTimerKey(activeId));
      while (workout.stage !== 'recap') {
        if (!workout.activeIntervalId) {
          workout = startInterval(workout);
          if (!workout.activeIntervalId) break;
          record('start-interval', 'batch', workout.activeIntervalId);
        }
        const id = workout.activeIntervalId;
        workout = completeActiveInterval(workout);
        record('complete-interval', 'batch', id);
      }
      workout = { ...workout, completionMode: 'batch-simulated' };
      return showWorkout('Simulated remaining session to reach recap.');
  }
}

// On-screen options and a few typed commands drive the session directly. A typed
// request to change the plan goes to the coach instead, which answers with a Proposal.
function runWorkoutCommand(text: string, typed: boolean) {
  lastSendTyped = typed;
  const t = text.trim().toLowerCase();
  if (t.includes('restart demo session') || t === 'restart') dispatch('restart');
  else if (t.includes('start demo session') || t === 'start workout') dispatch('start-session');
  else if (t.includes('start opening')) dispatch('start-interval', 'opening');
  else if (t.includes('simulate interval finish') || t.includes('finish interval')) dispatch('complete-interval');
  else if (t.includes('continue next slot') || t === 'continue') dispatch('start-interval');
  else if (t.includes('end session') || t === 'stop workout') dispatch('end-session');
  else if (!typed && t === 'make it easier') dispatch('ease');
  else if (!typed && t === 'i have 5 minutes left') dispatch('shorten', 300);
}

// Called when the active interval's timer runs out or is finished by hand.
function finishWorkoutTimer(id: string): boolean {
  if (!workoutActive || !workout.activeIntervalId || intervalTimerKey(workout.activeIntervalId) !== id) return false;
  dispatch('complete-interval', undefined, 'timer');
  return true;
}

function workoutSnapshot(): string | null {
  if (!workoutActive) return null;
  sentPlan = { sessionId: workout.sessionId, adaptations: workout.adaptationHistory.length };
  return JSON.stringify(workout);
}

// Returns true when the reply belongs to the workout, so its fences are not applied as a screen.
function onCoachReply(reply: string): boolean {
  if (!workoutActive) return false;
  const proposal = extractProposal(reply, workout.revision, workout.sessionId);
  if (!proposal) return true;
  if (sentPlan?.sessionId !== workout.sessionId || sentPlan.adaptations !== workout.adaptationHistory.length) {
    c.localEvent('Coach proposal not applied: the plan changed while the reply was in progress. Ask again if you still want it.', false);
    return true;
  }
  const result = applyAdaptation(workout, proposal, activeRemaining());
  if (result.applied) {
    workout = result.session;
    record('adaptation', 'model', undefined, result.summary);
    showWorkout('Adaptation applied: ' + result.summary);
  } else if (lastSendTyped) {
    c.localEvent(result.summary, false);
  }
  return true;
}

// The screen holds remaining time as of the last change; count it down with the running timer.
function watchRemaining(surface: HTMLElement) {
  const figure = surface.querySelector('[data-statement="remainingStat"] strong');
  if (!figure) return;
  updates.push(() => {
    const live = activeRemaining();
    if (live !== undefined) figure.textContent = formatClock(calculateRemainingSeconds(workout, live));
  });
}

setInterval(tick,250);void start();

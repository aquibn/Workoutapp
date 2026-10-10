import { el, button } from './dom.js';
import type { StatementNode } from '../shared/openui/openui-model.js';
import type { TimerLedger } from '../shared/openui/timer-store.js';
export type Context = { send: (text:string)=>void; timers: TimerLedger; timerAction: (id:string, action:'start'|'pause'|'reset'|'finish')=>void; updates: (()=>void)[]; paused: boolean };
// Trusted DOM ports of the source component signatures; no model-generated code.
export const renderers: Record<string,(node:StatementNode,context:Context)=>HTMLElement> = {
  Text: ({props:p}) => el(p.variant==='title'?'h3':p.variant==='subtitle'?'h4':'p',String(p.text),'block block-'+String(p.variant??'body')),
  Keyword: ({props:p}) => {const n=el('div','','keyword');n.append(el('strong',String(p.text)));if(p.caption)n.append(el('p',String(p.caption)));return n;},
  Alert: ({props:p}) => el('aside',String(p.text),'block alert'),
  List: ({props:p},c) => {const n=el((p.items as StatementNode[]).every(r=>r.props.marker==='numbered')?'ol':'ul','','block');for(const row of p.items as StatementNode[])n.append(renderComponent(row,c));return n;},
  ListItem: ({props:p}) => {const n=el('li',String(p.text));if(typeof p.marker==='string')n.dataset.marker=p.marker;return n;},
  FollowUps: ({props:p},c) => {const n=el('div','','row');for(const text of p.prompts as string[])n.append(button(text,()=>c.send(text)));return n;},
  Timer: ({key,props:p},c) => {
    const n=el('section','','timer');n.setAttribute('aria-label',String(p.label));
    n.append(el('p','SIMULATED TIMER','eyebrow'),el('h3',String(p.label)));
    const value=el('strong'),status=el('span','','micro timer-status'),row=el('div','','row');
    const start=button('Start simulation',()=>c.timerAction(key,'start')),pause=button('Pause timer',()=>c.timerAction(key,'pause')),reset=button('Reset timer',()=>c.timerAction(key,'reset')),finish=button('Simulate finish',()=>c.timerAction(key,'finish'));
    row.append(start,pause,reset,finish);n.append(value,status,row);
    const update=()=>{const entry=c.timers.list().find(t=>t.id===key);if(!entry)return;const seconds=Math.ceil(entry.remaining);value.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;status.textContent=entry.status;start.hidden=entry.status==='running'||entry.status==='paused';start.textContent=entry.status==='done'?'Restart simulation':'Start simulation';pause.hidden=entry.status==='stopped'||entry.status==='done';pause.textContent=entry.status==='paused'?'Resume timer':'Pause timer';for(const b of [start,pause,reset,finish])b.disabled=c.paused;};
    c.updates.push(update);update();return n;
  },
  // Each cell is "kind:status:seconds"; width follows duration so the shape of the plan is visible.
  PlanStrip: ({props:p}) => {const cells=(p.cells as string[]).map(v=>v.split(':'));const n=el('div','','plan-strip');n.setAttribute('role','img');n.setAttribute('aria-label',`${cells.filter(([,s])=>s==='completed').length} of ${cells.filter(([,s])=>s!=='removed').length} intervals done`);for(const [kind,status,seconds] of cells){const cell=el('span','',`${kind} ${status}`);cell.style.flexGrow=seconds;n.append(cell);}return n;},
  Suggest: ({props:p}) => el('div', `Coach suggestion: ${String(p.intent)}`, 'micro proposal-pill'),
  Proposal: ({props:p}) => el('div', `Adjustment proposal: ${String(p.intent)}${p.seconds ? ` (${p.seconds}s)` : ''}`, 'micro proposal-pill'),
};
export function renderComponent(node:StatementNode,context:Context):HTMLElement {
  if(!Object.hasOwn(renderers,node.name))throw new Error('No renderer for '+node.name);
  const n=renderers[node.name](node,context);n.dataset.statement=node.key;
  if(typeof node.props.color==='string' && /^#[0-9a-fA-F]{6}$/.test(node.props.color))n.style.color=node.props.color;
  return n;
}

import assert from 'node:assert/strict';
import { newGame, logEvent } from '../src/game/state.js';
import { applyVeto, applyNominations, applyEviction } from '../src/game/season.js';
import { publicFacts, knowledgeFor, formatEvidence, rememberExchange } from '../src/game/knowledge.js';
import { buildChatSystemPrompt, buildGroupSystemPrompt, buildJurorQuestionPrompt, buildJurorVotePrompt, buildThreadMessages } from '../src/ai/prompts.js';
import { validateNarrative, assertVetoOwnership } from '../src/ai/grounding.js';
import { fallbackChat, fallbackOpener, fallbackJurorQuestion, fallbackJurorVote } from '../src/ai/fallback.js';
import { npcChat, groupChat, jurorQuestion, jurorVote, diaryChat } from '../src/ai/dialogue.js';
import { serverNpcChat, serverGroupChat, serverJurorQuestion, serverJurorVote, serverDiaryChat } from '../party/ai.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function vetoGame() {
  const g = newGame('Steven'); g.hoh = 'marcus'; g.phase = 'veto_ceremony';
  applyNominations(g, 'marcus', ['rae', 'bev']);
  g.vetoHolder = 'you'; g.compHistory.push({ week: 1, type: 'veto', winner: 'you', scores: {} });
  logEvent(g, 'veto_win', 'Steven won the Power of Veto.', ['you']);
  applyVeto(g, 'you', true, 'rae', 'tessa'); g.phase = 'campaigning';
  return g;
}
async function mocked(candidate, verdict, fn) {
  const original = globalThis.fetch; const previousLocation = globalThis.location;
  globalThis.location = { hostname: 'localhost' };
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const value = body.system.startsWith('You verify') ? verdict : candidate;
    return { ok: true, status: 200, json: async () => ({ text: JSON.stringify(value), content: [{ type: 'text', text: JSON.stringify(value) }] }) };
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; globalThis.location = previousLocation; }
}

test('veto winner, user, saved nominee and replacement owner stay distinct', () => {
  const g = vetoGame(), facts = publicFacts(g);
  assert.equal(facts.find(f => f.kind === 'veto_win').actorId, 'you');
  assert.equal(facts.find(f => f.kind === 'veto_used').actorId, 'you');
  assert.deepEqual(facts.find(f => f.kind === 'veto_used').targetIds, ['rae']);
  assert.equal(facts.find(f => f.kind === 'replacement').actorId, 'marcus');
  assert.match(buildChatSystemPrompt(g, 'bev'), /Steven.*id you/);
});
test('public recap excludes private promises, alliances and leaks', () => {
  const g = vetoGame(); logEvent(g, 'promise', 'SECRET_PLAN', ['marcus','zoe']); logEvent(g, 'leak', 'PRIVATE_LEAK', ['marcus','zoe']);
  assert.doesNotMatch(buildChatSystemPrompt(g, 'bev'), /SECRET_PLAN|PRIVATE_LEAK/);
});
test('full public record survives many later conversations', () => {
  const g = vetoGame(); for(let i=0;i<30;i++) logEvent(g,'promise','noise',['marcus','zoe']);
  assert.match(buildChatSystemPrompt(g,'bev'), /Steven used the Power of Veto to save Rae/);
});
test('old transcript is dated and cannot redefine the authoritative actor', () => {
  const g = vetoGame(); g.threads.bev = [{who:'them',text:'I won veto.',week:1,phase:'campaigning'}]; g.week=2;
  assert.match(buildThreadMessages(g,'bev','No, I won.')[1].content, /Week 1, campaigning/);
});
test('reported first-person veto hallucination is blocked even if reviewer would approve', async () => {
  const g = vetoGame(); let checked=false;
  await assert.rejects(validateNarrative(g,'bev','you',{reply:'I had to win and use the veto myself.'},async()=>{checked=true;return{valid:true};}));
  assert.equal(checked,false); assert.doesNotThrow(()=>assertVetoOwnership(g,'you','I won and used the veto.'));
});
test('truthful corrections in offline mode have no relationship penalties', () => {
  const g=vetoGame(), result=fallbackChat(g,'bev','You are wrong. I won and used the veto.');
  assert.match(result.reply,/Steven used/); assert.equal(result.effects.trustDelta,0); assert.equal(result.effects.suspicionOfLie,false);
});
test('stale veto opener does not beg for a completed ceremony', () => {
  const g=vetoGame(); assert.doesNotMatch(fallbackOpener(g,'bev','beg_veto'),/use it on me|could save/);
});
test('jury knowledge freezes at eviction including facts, feelings and rumor provenance', () => {
  const g=vetoGame(); g.memory.bev.gossipHeard.push({text:'Steven ran a secret alliance',fromId:'zoe',aboutId:'you',week:1,believed:true});
  applyEviction(g,'bev',{'you':'bev','rae':'tessa'});
  const frozen=JSON.stringify(knowledgeFor(g,'bev'));
  g.week=2; logEvent(g,'veto_win','Rae won veto.',['rae']); g.social.bev.you.trust=0; g.memory.bev.gossipHeard[0].text='changed';
  assert.equal(JSON.stringify(knowledgeFor(g,'bev')),frozen);
  assert.doesNotMatch(formatEvidence(g,'bev'),/Rae won the Power|changed/);
  assert.match(formatEvidence(g,'bev'),/UNVERIFIED: Zoe/);
});
test('legacy saves reconstruct only events through eviction', () => {
  const g=vetoGame(); applyEviction(g,'bev',{}); delete g.memory.bev.juryRecord;
  g.week=2;logEvent(g,'hoh','Nash won HoH.',['nash']);
  assert.doesNotMatch(buildJurorQuestionPrompt(g,'bev',['you','rae']),/Nash won/);
  assert.match(formatEvidence(g,'bev'),/Steven used/);
});
test('legacy promises do not gain later outcome knowledge', () => {
  const g=vetoGame();g.promises.push({id:'old',from:'you',to:'bev',text:'final two',kind:'final2',week:1,status:'open'});
  applyEviction(g,'bev',{});delete g.memory.bev.juryRecord;g.promises[0].status='broken';
  assert.match(formatEvidence(g,'bev'),/outcome at eviction unknown/);
  assert.doesNotMatch(fallbackJurorQuestion(g,'bev',['you','rae']).questionForF1,/went back on|broke/);
});
test('juror cannot learn private ballots from a promise status', () => {
  const g=vetoGame();g.promises.push({id:'v',from:'you',to:'bev',text:'keep you',kind:'vote',week:1,status:'broken'});applyEviction(g,'bev',{'you':'bev'});
  assert.match(formatEvidence(g,'bev'),/individual ballots are secret/);
  assert.doesNotMatch(formatEvidence(g,'bev'),/Recorded status: broken/);
});
test('empty bitter juror history produces an open question, not a fabricated promise', () => {
  const g=newGame('Steven');const q=fallbackJurorQuestion(g,'bev',['you','marcus']);
  assert.doesNotMatch(q.questionForF1,/made promises|played me|broke/);
});
test('jury questions and votes use the same frozen evidence and actual questions', () => {
  const g=vetoGame();applyEviction(g,'bev',{});const q=fallbackJurorQuestion(g,'bev',['you','rae']);
  const prompt=buildJurorVotePrompt(g,'bev',['you','rae'],{...q,f1Answer:'I chose to protect Rae.',f2Answer:'I survived.'});
  assert.ok(prompt.includes(q.questionForF1)); assert.match(prompt,/truthful|correction/);
});
test('conversation memory stores quotes, not generated factual summaries', () => {
  const g=vetoGame();rememberExchange(g,'bev','you','I heard Zoe has a deal.');
  assert.equal(g.memory.bev.convoSummaries[0].source,'quoted_statement');assert.match(g.memory.bev.convoSummaries[0].summary,/Steven said:/);
});
test('group context uses actual listener rather than single-player identity', () => {
  const g=vetoGame();g.houseguests.find(h=>h.id==='rae').name='Brittany';const prompt=buildGroupSystemPrompt(g,['bev','marcus'],'rae');
  assert.match(prompt,/you is Brittany \(rae\)/);assert.match(prompt,/Your feelings about Brittany/);
});
test('invalid jury evidence IDs fail closed', async()=>{
  await assert.rejects(validateNarrative(vetoGame(),'bev',['you','rae'],{evidenceForF1:['event:9999']},async()=>({valid:true}),{citations:['evidenceForF1']}));
});
test('single-player rejects unsupported effects and does not retain invented response', async()=>{
  const g=vetoGame();const before=g.social.bev.you.trust;
  await mocked({reply:'You betrayed our secret final-two deal.',effects:{trustDelta:-8,suspicionOfLie:true,summary:'Invented story'}},{valid:false},async()=>{
    const r=await npcChat(g,'bev','Actually, I used the veto on Rae.');
    assert.doesNotMatch(r.reply,/secret final-two/);assert.equal(g.social.bev.you.trust,before);assert.equal(g.memory.bev.grudges.length,0);
    assert.doesNotMatch(JSON.stringify(g.threads.bev),/secret final-two/);
  });
});
test('single-player accepts a verified natural reply and dates its transcript', async()=>{
  const g=vetoGame();await mocked({reply:'Steven used the veto on Rae. What was your reasoning?',effects:{}},{valid:true},async calls=>{
    const r=await npcChat(g,'bev','Can we talk?');assert.match(r.reply,/reasoning/);assert.equal(calls.length,2);assert.equal(g.threads.bev[1].week,1);
  });
});
test('online chat uses the same factual gate before returning effects', async()=>{
  const g=vetoGame();await mocked({reply:'I had to win and use the veto myself.',effects:{trustDelta:-8}},{valid:true},async()=>{
    const r=await serverNpcChat(g,'bev','Who used veto?','you',[],'test-key');assert.equal(r.usedAi,false);assert.match(r.reply,/Steven/);assert.equal(r.effects.trustDelta,0);
  });
});
test('group hallucination cannot mutate either offline or online member effects', async()=>{
  const g=vetoGame();await mocked({replies:[{id:'bev',reply:'I won veto.'}],effects:{bev:{trustDelta:-8}}},{valid:true},async()=>{
    const a=await groupChat(g,['bev','marcus'],'Actually, I used veto.',[]);assert.doesNotMatch(JSON.stringify(a.replies),/I won veto/);
    const b=await serverGroupChat(g,['bev','marcus'],'you','Actually, I used veto.',[],'test-key');assert.equal(b.usedAi,false);
  });
});
test('invalid jury allegations fall back in both runtimes', async()=>{
  const g=vetoGame();applyEviction(g,'bev',{});
  await mocked({questionForF1:'Why did you break our secret deal?',questionForF2:'Why did you betray me?',evidenceForF1:[],evidenceForF2:[]},{valid:false},async()=>{
    assert.doesNotMatch((await jurorQuestion(g,'bev',['you','rae'])).questionForF1,/secret deal/);
    assert.equal((await serverJurorQuestion(g,'bev',['you','rae'],'test-key')).usedAi,false);
  });
});
test('invalid AI jury vote is rejected rather than merely sanitizing its reasoning', async()=>{
  const g=vetoGame();applyEviction(g,'bev',{});const qa={f1Answer:'I chose to protect Rae.',f2Answer:'I wanted to survive.'};
  await mocked({vote:'rae',reasoning:'Steven evicted me in week 99.',evidenceIds:[]},{valid:false},async()=>{
    assert.doesNotMatch((await jurorVote(g,'bev',['you','rae'],qa)).reasoning,/week 99/);
    assert.equal((await serverJurorVote(g,'bev',['you','rae'],qa,'test-key')).usedAi,false);
  });
});
test('offline answer assessment does not reward repeating more words',()=>{
  const g=vetoGame();applyEviction(g,'bev',{});const qa={f1Answer:'I chose to protect Rae because of trust.',f2Answer:'I survived.'};
  const a=fallbackJurorVote(g,'bev',['you','rae'],qa).answerQuality.you;
  const b=fallbackJurorVote(g,'bev',['you','rae'],{...qa,f1Answer:qa.f1Answer.repeat(20)}).answerQuality.you;assert.equal(a,b);
});
test('Diary Room has zero social/record side effects and no additional factual-audit call',async()=>{
  const g=vetoGame(), before=JSON.stringify({...g,diary:[]});
  await mocked({reply:'How do you feel about that decision?'},{valid:true},async calls=>{
    await diaryChat(g,'I want to reflect.');assert.equal(JSON.stringify({...g,diary:[]}),before);assert.equal(calls.length,1);
    const again=JSON.stringify(g);await serverDiaryChat(g,'you',g.diary,'test-key');assert.equal(JSON.stringify(g),again);
  });
});

test('jury preserves attributed conversation claims without turning them into events', () => {
  const g=vetoGame(); rememberExchange(g,'bev','you','I secretly controlled all the votes.');
  applyEviction(g,'bev',{}); rememberExchange(g,'bev','you','I won again after you left.');
  const record=knowledgeFor(g,'bev'); assert.equal(record.statements.length,1);
  assert.match(formatEvidence(g,'bev'),/not whether the claim is true/);
  assert.doesNotMatch(formatEvidence(g,'bev'),/won again after you left/);
});

test('server uses supported model parameters for both generation and factual review', async () => {
  const g=vetoGame();
  await mocked({reply:'What would help your game this week?',effects:{}},{valid:true},async calls => {
    assert.equal((await serverNpcChat(g,'bev','Can we talk?','you',[],'test-key')).usedAi,true);
    assert.equal(calls.length,2);
    for(const body of calls) { assert.equal(body.thinking.type,'disabled'); assert.equal(body.temperature,undefined); }
  });
});

test('group context does not deny the actual veto winner their own win', () => {
  const g=vetoGame();g.vetoHolder='rae';
  const prompt=buildGroupSystemPrompt(g,['rae','bev'],'you');
  assert.match(prompt,/Only this named winner may claim/); assert.doesNotMatch(prompt,/This is NOT your win/);
});

test('denying a promise does not create a new one in the fallback', () => {
  const g=vetoGame();const r=fallbackChat(g,'bev','I never promised to keep you safe.');
  assert.equal(r.effects.promiseMade,undefined);assert.equal(r.effects.suspicionOfLie,false);
});

let failed=0;
for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
console.log(`${tests.length-failed}/${tests.length} grounding regressions passed`);if(failed)process.exitCode=1;

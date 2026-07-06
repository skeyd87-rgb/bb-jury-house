// Dialogue orchestrator: routes chat to Claude (via the app's server-hosted
// key) or the offline fallback engine, validates the effect payload, applies
// it, and maintains threads/summaries.

import { askClaudeJson } from './claude.js';
import { setAiStatus } from './status.js';
import {
  buildChatSystemPrompt,
  buildThreadMessages,
  buildDiarySystemPrompt,
  buildSpeechPrompt,
  buildJurorQuestionPrompt,
  buildJurorVotePrompt,
  buildOpponentAnswerPrompt,
  buildOpenerPrompt,
  buildGroupSystemPrompt,
  buildAnalysisPrompt,
} from './prompts.js';
import {
  fallbackChat,
  fallbackDiary,
  fallbackSpeech,
  fallbackJurorQuestion,
  fallbackJurorVote,
  fallbackOpener,
  fallbackGroupChat,
  fallbackAnalysis,
} from './fallback.js';
import { applyChatEffects } from '../game/social.js';
import { PLAYER_ID } from '../game/cast.js';

const VALID_KINDS = ['safety', 'vote', 'final2', 'alliance', 'vote_evict', 'info'];
const VALID_SIGNALS = ['none', 'propose', 'accept'];

function sanitizeEffects(raw, npcIds) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return {
    trustDelta: e.trustDelta ?? 0,
    bondDelta: e.bondDelta ?? 0,
    threatDelta: e.threatDelta ?? 0,
    promiseMade:
      e.promiseMade && e.promiseMade.text
        ? {
            text: String(e.promiseMade.text),
            kind: VALID_KINDS.includes(e.promiseMade.kind) ? e.promiseMade.kind : 'safety',
            targetId: npcIds.includes(e.promiseMade.targetId) ? e.promiseMade.targetId : null,
            protectedIds: Array.isArray(e.promiseMade.protectedIds)
              ? e.promiseMade.protectedIds.filter((id) => npcIds.includes(id))
              : [],
          }
        : null,
    allianceSignal: VALID_SIGNALS.includes(e.allianceSignal) ? e.allianceSignal : 'none',
    suspicionOfLie: !!e.suspicionOfLie,
    secretShared: e.secretShared ? String(e.secretShared) : null,
    targetDiscussed: npcIds.includes(e.targetDiscussed) ? e.targetDiscussed : null,
    allianceProposal:
      e.allianceProposal && typeof e.allianceProposal === 'object'
        ? {
            accepted: !!e.allianceProposal.accepted,
            name: e.allianceProposal.name ? String(e.allianceProposal.name).slice(0, 40) : null,
            memberIds: Array.isArray(e.allianceProposal.memberIds)
              ? e.allianceProposal.memberIds.filter((id) => npcIds.includes(id))
              : [],
          }
        : null,
    summary: e.summary ? String(e.summary).slice(0, 200) : null,
  };
}

export async function npcChat(g, npcId, playerMsg) {
  const npcIds = g.houseguests.map((h) => h.id);
  let result;
  try {
    result = await askClaudeJson({
      system: buildChatSystemPrompt(g, npcId),
      messages: buildThreadMessages(g, npcId, playerMsg),
      maxTokens: 900,
    });
    setAiStatus(true);
  } catch (err) {
    setAiStatus(false);
    result = fallbackChat(g, npcId, playerMsg);
  }

  const reply = String(result.reply || '...').slice(0, 600);
  const effects = sanitizeEffects(result.effects, npcIds);

  // Record thread
  if (!g.threads[npcId]) g.threads[npcId] = [];
  g.threads[npcId].push({ who: 'you', text: playerMsg });
  g.threads[npcId].push({ who: 'them', text: reply });
  g.threads[npcId] = g.threads[npcId].slice(-24);

  // Apply effects + memory summary
  applyChatEffects(g, npcId, playerMsg, effects);
  if (effects.summary) {
    g.memory[npcId].convoSummaries.push({ withId: PLAYER_ID, week: g.week, summary: effects.summary });
    g.memory[npcId].convoSummaries = g.memory[npcId].convoSummaries.slice(-20);
  }
  g.chatTurnsThisPhase++;

  return { reply, effects };
}

// NPC approached the player — they speak first.
export async function npcOpener(g, npcId, reason) {
  let reply = null;
  try {
    const r = await askClaudeJson({
      system: buildOpenerPrompt(g, npcId, reason),
      messages: [{ role: 'user', content: '(The player turns to you as you walk over.)' }],
      maxTokens: 400,
    });
    if (r.reply) { reply = String(r.reply).slice(0, 500); setAiStatus(true); }
  } catch (err) {
    setAiStatus(false);
  }
  if (!reply) reply = fallbackOpener(g, npcId, reason);
  if (!g.threads[npcId]) g.threads[npcId] = [];
  g.threads[npcId].push({ who: 'them', text: reply });
  g.threads[npcId] = g.threads[npcId].slice(-24);
  return reply;
}

// Group conversation: one call, several voices, effects for everyone present.
export async function groupChat(g, memberIds, playerMsg, history) {
  let result = null;
  try {
    const msgs = history.slice(-14).map((m) => ({
      role: m.who === 'you' ? 'user' : 'assistant',
      content: m.who === 'you' ? m.text : JSON.stringify({ replies: [{ id: m.id, reply: m.text }] }),
    }));
    msgs.push({ role: 'user', content: playerMsg });
    if (msgs[0].role === 'assistant') msgs.unshift({ role: 'user', content: '(The group gathers.)' });
    result = await askClaudeJson({
      system: buildGroupSystemPrompt(g, memberIds),
      messages: msgs,
      // Scale with group size so big house meetings never truncate mid-JSON.
      maxTokens: Math.min(3000, 700 + memberIds.length * 300),
    });
  } catch (err) {
    // fall through
  }
  if (!result || !Array.isArray(result.replies)) {
    setAiStatus(false);
    result = fallbackGroupChat(g, memberIds, playerMsg);
  } else {
    setAiStatus(true);
  }

  const replies = result.replies
    .filter((r) => memberIds.includes(r.id) && r.reply)
    .slice(0, 3)
    .map((r) => ({ id: r.id, reply: String(r.reply).slice(0, 400) }));

  // Apply per-member effects (public conversation: everyone forms an opinion)
  const npcIds = g.houseguests.map((h) => h.id);
  for (const id of memberIds) {
    const raw = (result.effects && result.effects[id]) || {};
    const effects = sanitizeEffects(
      {
        ...raw,
        // group-level payloads ride along on each member
        promiseMade: result.promiseMade || null,
      },
      npcIds
    );
    effects.allianceSignal = 'none';
    effects.allianceProposal = null; // handled once below
    applyChatEffects(g, id, playerMsg, effects);
    if (effects.summary) {
      g.memory[id].convoSummaries.push({ withId: PLAYER_ID, week: g.week, summary: `(group) ${effects.summary}` });
      g.memory[id].convoSummaries = g.memory[id].convoSummaries.slice(-20);
    }
  }

  const proposal =
    result.allianceProposal && typeof result.allianceProposal === 'object'
      ? {
          accepted: !!result.allianceProposal.accepted,
          name: result.allianceProposal.name ? String(result.allianceProposal.name).slice(0, 40) : null,
          decliners: Array.isArray(result.allianceProposal.decliners)
            ? result.allianceProposal.decliners.filter((id) => memberIds.includes(id))
            : [],
        }
      : null;

  return { replies, proposal, promiseMade: result.promiseMade || null };
}

// Post-game strategy diagnostic.
export async function postGameAnalysis(g, stats) {
  try {
    const r = await askClaudeJson({
      system: buildAnalysisPrompt(g, stats),
      messages: [{ role: 'user', content: 'Deliver the diagnostic now.' }],
      maxTokens: 800,
      temperature: 0.9,
    });
    if (r.analysis) { setAiStatus(true); return String(r.analysis).slice(0, 3000); }
  } catch (err) {
    setAiStatus(false);
  }
  return fallbackAnalysis(stats);
}

export async function diaryChat(g, playerMsg) {
  g.diary.push({ who: 'you', text: playerMsg });
  let result;
  try {
    const msgs = g.diary.slice(-10).map((m) => ({
      role: m.who === 'you' ? 'user' : 'assistant',
      content: m.who === 'you' ? m.text : JSON.stringify({ reply: m.text }),
    }));
    result = await askClaudeJson({ system: buildDiarySystemPrompt(g), messages: msgs, maxTokens: 300 });
    setAiStatus(true);
  } catch (err) {
    setAiStatus(false);
    result = fallbackDiary(g);
  }
  const reply = String(result.reply || '...').slice(0, 400);
  g.diary.push({ who: 'them', text: reply });
  g.diary = g.diary.slice(-30);
  return reply;
}

export async function npcSpeech(g, npcId, kind, extra = {}) {
  try {
    const r = await askClaudeJson({
      system: buildSpeechPrompt(g, npcId, kind, extra),
      messages: [{ role: 'user', content: 'Deliver it now.' }],
      maxTokens: 250,
    });
    if (r.reply) { setAiStatus(true); return String(r.reply).slice(0, 400); }
  } catch (err) {
    setAiStatus(false);
  }
  return fallbackSpeech(g, npcId, kind, extra).reply;
}

export async function jurorQuestion(g, jurorId, finalists) {
  try {
    const r = await askClaudeJson({
      system: buildJurorQuestionPrompt(g, jurorId, finalists),
      messages: [{ role: 'user', content: 'Ask your questions now.' }],
      maxTokens: 600,
    });
    if (r.questionForF1 && r.questionForF2) { setAiStatus(true); return r; }
  } catch (err) {
    setAiStatus(false);
  }
  return fallbackJurorQuestion(g, jurorId, finalists);
}

export async function opponentJuryAnswer(g, opponentId, jurorId, question) {
  try {
    const r = await askClaudeJson({
      system: buildOpponentAnswerPrompt(g, opponentId, jurorId, question),
      messages: [{ role: 'user', content: 'Answer the juror now.' }],
      maxTokens: 300,
    });
    if (r.reply) { setAiStatus(true); return String(r.reply).slice(0, 500); }
  } catch (err) {
    setAiStatus(false);
  }
  return "I played my heart out, I owned my choices, and I'm asking for your respect, not your forgiveness.";
}

export async function jurorVote(g, jurorId, finalists, qa) {
  try {
    const r = await askClaudeJson({
      system: buildJurorVotePrompt(g, jurorId, finalists, qa),
      messages: [{ role: 'user', content: 'Cast your vote now.' }],
      maxTokens: 600,
      temperature: 1.0,
    });
    if (r.vote && finalists.includes(r.vote)) {
      setAiStatus(true);
      return { vote: r.vote, reasoning: String(r.reasoning || '').slice(0, 300) };
    }
  } catch (err) {
    setAiStatus(false);
  }
  const fb = fallbackJurorVote(g, jurorId, finalists, qa);
  return { vote: fb.vote, reasoning: fb.reasoning };
}

// Server-side AI dialogue. If the room has an Anthropic key, houseguests are
// voiced by Claude (chatter-aware prompts); otherwise the built-in engine.
// Returns { reply, effects } — same shape as the client AI layer.

import {
  buildChatSystemPrompt, buildThreadMessages,
  buildJurorQuestionPrompt, buildOpponentAnswerPrompt, buildJurorVotePrompt,
} from '../src/ai/prompts.js';
import { fallbackChat, fallbackJurorQuestion, fallbackJurorVote } from '../src/ai/fallback.js';
import { extractJson } from '../src/ai/claude.js';

const MODEL = 'claude-sonnet-5';

async function callClaude(apiKey, system, messages, maxTokens = 600) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 1.0, system, messages }),
  });
  if (!res.ok) throw new Error('claude ' + res.status);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// g: full engine game; npcId: houseguest being spoken to; chatterId: the human
// engine id; thread: prior [{who:'you'|'them', text}] for this pair.
export async function serverNpcChat(g, npcId, playerMsg, chatterId, thread, apiKey) {
  if (apiKey) {
    try {
      const system = buildChatSystemPrompt(g, npcId, chatterId);
      // buildThreadMessages reads g.threads[npcId]; feed our per-pair thread.
      const saved = g.threads[npcId];
      g.threads[npcId] = thread;
      const messages = buildThreadMessages(g, npcId, playerMsg);
      g.threads[npcId] = saved;
      const text = await callClaude(apiKey, system, messages, 900);
      const json = extractJson(text);
      if (json && json.reply) return { reply: String(json.reply).slice(0, 600), effects: json.effects || {} };
    } catch (err) {
      // fall through to the built-in engine
    }
  }
  return fallbackChat(g, npcId, playerMsg, chatterId);
}

// AI juror asks each finalist one question. Returns { questionForF1, questionForF2, toneNote }.
export async function serverJurorQuestion(g, jurorId, finalists, apiKey) {
  if (apiKey) {
    try {
      const text = await callClaude(apiKey, buildJurorQuestionPrompt(g, jurorId, finalists), [
        { role: 'user', content: 'Ask your questions now.' },
      ], 600);
      const json = extractJson(text);
      if (json && json.questionForF1 && json.questionForF2) return json;
    } catch (err) {
      // fall through to the built-in engine
    }
  }
  return fallbackJurorQuestion(g, jurorId, finalists);
}

// AI finalist answers a juror's question. Returns a string reply.
export async function serverOpponentAnswer(g, opponentId, jurorId, question, apiKey) {
  if (apiKey) {
    try {
      const text = await callClaude(apiKey, buildOpponentAnswerPrompt(g, opponentId, jurorId, question), [
        { role: 'user', content: 'Answer the juror now.' },
      ], 300);
      const json = extractJson(text);
      if (json && json.reply) return String(json.reply).slice(0, 500);
    } catch (err) {
      // fall through
    }
  }
  return "I played my heart out, I owned my choices, and I'm asking for your respect, not your forgiveness.";
}

// AI juror casts a vote after hearing both answers. Returns { vote, reasoning }.
export async function serverJurorVote(g, jurorId, finalists, qa, apiKey) {
  if (apiKey) {
    try {
      const text = await callClaude(apiKey, buildJurorVotePrompt(g, jurorId, finalists, qa), [
        { role: 'user', content: 'Cast your vote now.' },
      ], 600);
      const json = extractJson(text);
      if (json && json.vote && finalists.includes(json.vote)) {
        return { vote: json.vote, reasoning: String(json.reasoning || '').slice(0, 300) };
      }
    } catch (err) {
      // fall through
    }
  }
  const fb = fallbackJurorVote(g, jurorId, finalists, qa);
  return { vote: fb.vote, reasoning: fb.reasoning };
}

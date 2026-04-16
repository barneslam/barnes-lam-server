'use strict';
const { ok, err, preflight, loadSessions, searchSessions, buildContext, getSystemPrompt, callClaude } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const { message, history = [] } = JSON.parse(event.body || '{}');
    if (!message) return err('message required', 400);

    const sessions = await loadSessions();
    if (!sessions.length) return err('No sessions. Run /api/extract first.', 400);

    const relevant = searchSessions(sessions, message, 5);
    const context = buildContext(relevant);
    const systemPrompt = await getSystemPrompt();

    const fullSystem = `${systemPrompt}

RELEVANT TRANSCRIPTS FROM YOUR SESSIONS:
${context || 'No closely matching transcripts found — answer from your general patterns.'}

Answer as Barnes Lam. Be specific, direct, and grounded in the transcripts where possible.`;

    const messages = [...history.slice(-6), { role: 'user', content: message }];
    const answer = await callClaude(fullSystem, messages, 1200);

    const sources = relevant.map(s => ({
      title: s.title, date: (s.date || '').substring(0, 10), duration: s.duration
    }));

    return ok({ success: true, answer, sources });
  } catch(e) { return err(e.message); }
};

'use strict';
const { ok, err, preflight, loadSessions, loadEmails, savePersona, saveMemory, callClaude } = require('./_lib');

async function buildPersona(sessions, emails) {
  const barnesSpeech = sessions
    .filter(s => s.transcript)
    .slice(0, 20)
    .map(s => {
      const lines = s.transcript.split('\n')
        .filter(l => l.toLowerCase().includes('barnes'))
        .slice(0, 30).join('\n');
      return `[${s.title}]\n${lines}`;
    }).join('\n\n');

  const emailSamples = emails.slice(0, 8)
    .map(e => `[EMAIL: ${e.subject}]\n${(e.body || '').substring(0, 400)}`)
    .join('\n\n');

  const now = new Date().toISOString();
  const prompt = `Analyze these transcripts and emails from Barnes Lam. Extract a detailed persona profile.

MEETING TRANSCRIPTS:
${barnesSpeech.substring(0, 4000)}

WRITTEN EMAILS:
${emailSamples.substring(0, 2000)}

Return ONLY valid JSON:
{
  "communicationStyle": "2-3 sentences",
  "coreValues": ["v1","v2","v3","v4","v5"],
  "frameworks": ["f1","f2","f3"],
  "decisionPattern": "1-2 sentences",
  "characteristicPhrases": ["p1","p2","p3"],
  "recurringThemes": ["t1","t2","t3","t4"],
  "relationshipStyle": "how Barnes engages with others",
  "builtAt": "${now}"
}`;

  const raw = await callClaude('You are a behavioral analyst extracting communication patterns from transcripts.', [{ role: 'user', content: prompt }], 1000);
  return JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
}

async function buildMemory(sessions) {
  const peopleMap = {};
  for (const s of sessions) {
    for (const p of (s.participants || [])) {
      if (!p.toLowerCase().includes('barnes')) peopleMap[p] = (peopleMap[p] || 0) + 1;
    }
  }

  const titles = sessions.slice(0, 50)
    .map(s => `${(s.date || '').substring(0,10)}: ${s.title}`).join('\n');

  const now = new Date().toISOString();
  const prompt = `Here are Barnes Lam's meeting titles:\n\n${titles}\n\nReturn ONLY valid JSON:
{
  "topTopics": [{"topic":"name","frequency":"high/medium/low","description":"1 sentence"}],
  "thinkingEvolution": "2-3 sentences",
  "keyRelationships": [{"name":"meeting type or person","context":"what it's about"}],
  "lastUpdated": "${now}"
}`;

  const raw = await callClaude('You are analyzing meeting patterns for a personal knowledge system.', [{ role: 'user', content: prompt }], 800);
  const memory = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
  memory.topPeople = Object.entries(peopleMap)
    .sort((a,b) => b[1]-a[1]).slice(0, 10)
    .map(([name, meetingCount]) => ({ name, meetingCount }));
  memory.totalSessions = sessions.length;
  memory.withTranscript = sessions.filter(s => s.transcript).length;
  return memory;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const [sessions, emails] = await Promise.all([loadSessions(), loadEmails()]);
    if (!sessions.length) return err('No sessions. Extract first.', 400);

    const [persona, memory] = await Promise.all([
      buildPersona(sessions, emails),
      buildMemory(sessions)
    ]);
    await Promise.all([savePersona(persona), saveMemory(memory)]);
    return ok({ success: true, persona, memory });
  } catch(e) { return err(e.message); }
};

function preflight() { return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, body: '' }; }

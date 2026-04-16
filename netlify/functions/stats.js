'use strict';
const { ok, err, preflight, loadSessions, loadEmails, loadPersona, loadMemory } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const [sessions, emails, persona, memory] = await Promise.all([
      loadSessions(), loadEmails(), loadPersona(), loadMemory()
    ]);
    return ok({
      success: true,
      videoCount: sessions.length,
      transcriptCount: sessions.filter(s => s.transcript).length,
      emailCount: emails.length,
      podcastCount: 0,
      personaBuilt: !!persona,
      memoryBuilt: !!memory,
      kbActive: sessions.length > 0
    });
  } catch(e) { return err(e.message); }
};

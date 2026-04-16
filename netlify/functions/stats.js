'use strict';
const { ok, err, preflight, loadSessions, loadEmails, loadPodcasts, loadWebsite, loadPersonal, loadPersona, loadMemory } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const [sessions, emails, podcasts, website, personal, persona, memory] = await Promise.all([
      loadSessions(), loadEmails(), loadPodcasts(), loadWebsite(), loadPersonal(), loadPersona(), loadMemory()
    ]);
    return ok({
      success: true,
      videoCount: sessions.length,
      transcriptCount: sessions.filter(s => s.transcript).length,
      emailCount: emails.length,
      podcastCount: podcasts.length,
      websiteCount: website.length,
      personalLoaded: !!personal,
      personaBuilt: !!persona,
      memoryBuilt: !!memory,
      kbActive: sessions.length > 0 || emails.length > 0
    });
  } catch(e) { return err(e.message); }
};

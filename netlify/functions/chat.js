'use strict';
const {
  ok, err, preflight,
  loadSessions, loadEmails, loadPodcasts, loadWebsite, loadPersonal,
  searchSessions, searchEmails, searchPodcasts, searchWebsite, searchPersonal,
  buildContext, buildEmailContext, buildPodcastContext, buildWebsiteContext, buildPersonalContext,
  getSystemPrompt, callClaude
} = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const { message, history = [] } = JSON.parse(event.body || '{}');
    if (!message) return err('message required', 400);

    const [sessions, emails, podcasts, website, personal] = await Promise.all([
      loadSessions(), loadEmails(), loadPodcasts(), loadWebsite(), loadPersonal()
    ]);

    const relevantSessions  = searchSessions(sessions,  message, 5);
    const relevantEmails    = searchEmails(emails,    message, 3);
    const relevantPodcasts  = searchPodcasts(podcasts,  message, 3);
    const relevantWebsite   = searchWebsite(website,   message, 2);
    const relevantPersonal  = searchPersonal(personal,  message);

    const systemPrompt = await getSystemPrompt();

    const contextParts = [];
    if (relevantWebsite.length)  contextParts.push('WEBSITE CONTENT:\n'  + buildWebsiteContext(relevantWebsite));
    if (relevantSessions.length) contextParts.push('SESSION TRANSCRIPTS:\n' + buildContext(relevantSessions));
    if (relevantEmails.length)   contextParts.push('RELEVANT EMAILS:\n'  + buildEmailContext(relevantEmails));
    if (relevantPodcasts.length) contextParts.push('PODCAST CONTENT:\n'  + buildPodcastContext(relevantPodcasts));
    if (relevantPersonal)        contextParts.push('PERSONAL CONTEXT:\n' + buildPersonalContext(relevantPersonal));

    const fullSystem = `${systemPrompt}

${contextParts.length ? contextParts.join('\n\n') : 'No closely matching context found — answer from your general patterns.'}

Answer as Barnes Lam. Be specific, direct, and grounded in the context where possible.`;

    const messages = [...history.slice(-6), { role: 'user', content: message }];
    const answer = await callClaude(fullSystem, messages, 1200);

    const sources = [
      ...relevantSessions.map(s => ({ type: 'session', title: s.title, date: (s.date || '').substring(0,10), duration: s.duration })),
      ...relevantEmails.map(e  => ({ type: 'email',   title: e.subject, date: (e.date || '').substring(0,10) })),
      ...relevantPodcasts.map(p => ({ type: 'podcast', title: p.title })),
      ...relevantWebsite.map(w  => ({ type: 'website', title: w.title, url: w.url }))
    ];

    return ok({ success: true, answer, sources });
  } catch(e) { return err(e.message); }
};

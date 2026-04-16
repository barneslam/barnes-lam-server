'use strict';
const { ok, err, preflight, loadMemory } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  try {
    const memory = await loadMemory();
    return ok({ success: true, memory });
  } catch(e) { return err(e.message); }
};

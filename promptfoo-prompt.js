// Thin wrapper so promptfoo can call the real production prompt function.
// Does NOT modify preview-prompt.js — just adapts its (formData, research) signature
// to the ({ vars }) signature promptfoo expects from a JS prompt file.
//
// Also reproduces the exact system prompt worker.js sends alongside PREVIEW_PROMPT
// (worker.js line ~3020, CLAUDE_SYSTEM_PROMPT) so this eval matches production —
// if that string ever changes in worker.js, update it here too.
const { PREVIEW_PROMPT } = require('./preview-prompt.js');

const CLAUDE_SYSTEM_PROMPT = 'You are an expert travel planner producing output for an automated pipeline. Follow every instruction in the user message exactly. Output ONLY the requested format — no markdown code fences, no preamble, no commentary before or after your answer. When the user message requests JSON, your response must begin with the opening { or [ of that JSON and end with its closing } or ].';

module.exports = async function ({ vars }) {
  return [
    { role: 'system', content: CLAUDE_SYSTEM_PROMPT },
    { role: 'user', content: PREVIEW_PROMPT(vars, vars.perplexityResearch) },
  ];
};

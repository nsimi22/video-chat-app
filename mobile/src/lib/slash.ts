// Slash-command dispatcher — mobile port of renderer/chat.js _maybeRunSlash.
//
// Reads the user's settings from public.user_integrations.settings (shared
// row with desktop). AI commands hit api.anthropic.com / openrouter.ai
// directly via native fetch (no CORS on RN). /ai-ticket creates a real
// Jira issue via REST v3.

import { sendMessage, type Message, type Profile } from './api';
import { getAiSettings, getAiTicketSettings, getGithubSettings, getJiraSettings } from './integrations';
import { AiClient, summarize as aiSummarize } from './ai';
import { createJiraIssue, jiraIsConfigured, jiraIssueUrl } from './jira';

export type SlashCommand = {
  name: string;
  usage: string;
  desc: string;
  // True if this command requires AI / Jira config that isn't yet writable
  // from mobile. Surfaces as a hint in the autocomplete popup.
  desktopOnly?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'me', usage: '/me <action>', desc: 'Italicized third-person line ("Alice waves").' },
  { name: 'shrug', usage: '/shrug [text]', desc: 'Append ¯\\_(ツ)_/¯ to your message.' },
  { name: 'ai', usage: '/ai <question>', desc: 'Ask the configured AI; reply posts to the channel.' },
  { name: 'ai-ticket', usage: '/ai-ticket <description>', desc: 'AI drafts and creates a Jira ticket in your default project.' },
  { name: 'summarize', usage: '/summarize', desc: 'Summarize the last ~100 messages in this channel.' },
  { name: 'jira', usage: '/jira <KEY>', desc: 'Post a Jira issue URL — auto-unfurls. (/jira create is desktop-only.)' },
  { name: 'gh', usage: '/gh <owner/repo#N>', desc: 'Post a GitHub issue/PR URL — auto-unfurls.' },
];

export type SlashContext = {
  teamId: string;
  channelId: string;
  userId: string;
  roster: Profile[];
  // In-memory messages currently rendered (used by /summarize).
  recentMessages: Message[];
  onAiThinking: (active: boolean) => void;
  onError: (msg: string) => void;
};

// Returns true if the input was consumed as a slash command (so the composer
// should clear). False = treat as a normal message.
export async function runSlash(text: string, ctx: SlashContext): Promise<boolean> {
  const m = /^\/([\w-]+)(?:\s+([\s\S]+))?$/.exec(text);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  switch (cmd) {
    case 'me':
      return runMe(arg, ctx);
    case 'shrug':
      return runShrug(arg, ctx);
    case 'ai':
      return runAi(arg, ctx);
    case 'ai-ticket':
    case 'ait':
      return runAiTicket(arg, ctx);
    case 'summarize':
    case 'summary':
      return runSummarize(ctx);
    case 'gh':
    case 'github':
      return runGh(arg, ctx);
    case 'jira':
      return runJira(arg, ctx);
    default:
      return false;
  }
}

// --- /me, /shrug -----------------------------------------------------------

async function runMe(action: string, ctx: SlashContext): Promise<boolean> {
  const t = action.trim();
  if (!t) return true;
  await sendMessage({
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    authorId: ctx.userId,
    body: `_${t}_`,
  });
  return true;
}

async function runShrug(rest: string, ctx: SlashContext): Promise<boolean> {
  const shrug = '¯\\_(ツ)_/¯';
  const body = rest.trim() ? `${rest.trim()} ${shrug}` : shrug;
  await sendMessage({
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    authorId: ctx.userId,
    body,
  });
  return true;
}

// --- /gh, /jira <KEY> ------------------------------------------------------

async function runGh(arg: string, ctx: SlashContext): Promise<boolean> {
  const ref = arg.trim();
  if (!ref) {
    ctx.onError('Usage: /gh <owner/repo#N>');
    return true;
  }
  // Accept "owner/repo#123" or a bare URL.
  let url = ref;
  if (!/^https?:\/\//i.test(ref)) {
    const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref);
    if (!m) {
      ctx.onError('Usage: /gh <owner/repo#N>');
      return true;
    }
    url = `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`;
  }
  await sendMessage({
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    authorId: ctx.userId,
    body: url,
  });
  return true;
}

async function runJira(arg: string, ctx: SlashContext): Promise<boolean> {
  if (!arg || /^create\b/i.test(arg)) {
    ctx.onError('The Jira ticket-create modal is desktop-only. Use /ai-ticket for a one-shot create from mobile.');
    return true;
  }
  const jira = await getJiraSettings(ctx.userId);
  if (!jiraIsConfigured(jira)) {
    ctx.onError('Jira is not configured. Open Settings (⚙) on desktop to add your Atlassian credentials.');
    return true;
  }
  const key = arg.toUpperCase();
  const url = jiraIssueUrl(jira.host, key);
  await sendMessage({
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    authorId: ctx.userId,
    body: url,
  });
  return true;
}

// --- AI commands -----------------------------------------------------------

const AI_SYSTEM_PROMPT =
  'You are a helpful, general-purpose AI assistant inside a team chat app. Answer whatever the user asks. Be concise.';

async function getAiClient(userId: string): Promise<AiClient | null> {
  const s = await getAiSettings(userId);
  if (!s) return null;
  const c = new AiClient(s);
  return c.isConfigured() ? c : null;
}

async function runAi(prompt: string, ctx: SlashContext): Promise<boolean> {
  if (!prompt) {
    ctx.onError('Usage: /ai <your question>');
    return true;
  }
  const ai = await getAiClient(ctx.userId);
  if (!ai) {
    ctx.onError('No AI provider is configured. Open Settings (⚙) on desktop to add an Anthropic or OpenRouter API key.');
    return true;
  }
  ctx.onAiThinking(true);
  try {
    const result = await ai.chat({
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    const body = `> ${prompt.replace(/\n/g, '\n> ')}\n\n${result.text || '(no response)'}`;
    await sendMessage({
      teamId: ctx.teamId,
      channelId: ctx.channelId,
      authorId: ctx.userId,
      body,
      aiGenerated: true,
      aiModel: result.model,
    });
  } catch (err) {
    ctx.onError(`AI request failed: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    ctx.onAiThinking(false);
  }
  return true;
}

const TICKET_SYSTEM_PROMPT = `You are a senior product manager. Turn the user's freeform input into a Jira ticket as a thoughtful senior PM would write it.

Output ONLY a single JSON object — no preamble, no markdown fences, no commentary outside the JSON. Shape:
{
  "summary": "concise imperative title (clear and complete)",
  "description": "rich markdown body with the structure below",
  "issueType": "Task" | "Bug" | "Story"
}

A senior-PM description includes the sections below. Omit any that don't apply. Use these literal H2 headings.

## Background
One to three sentences of context.

## Problem
For bugs: precise statement of what's broken, where, and the user-visible impact.
For net-new work: write "## Goal" instead and state the outcome we want.

## Acceptance criteria
Bulleted, individually testable, written as observable behaviors. Use "- [ ] ".

## Notes
Optional. Constraints, dependencies, related tickets, open questions.

Default to "Task". Pick "Bug" only when the input is clearly about something broken. Use "Story" for net-new feature work.

Output the JSON object and nothing else.`;

function parseTicketJson(raw: string): { summary?: string; description?: string; issueType?: string } {
  if (!raw) throw new Error('empty AI response');
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {}
  }
  throw new Error('response was not valid JSON');
}

async function runAiTicket(prompt: string, ctx: SlashContext): Promise<boolean> {
  if (!prompt) {
    ctx.onError('Usage: /ai-ticket <description>');
    return true;
  }
  const [ai, jira, aiTicket] = await Promise.all([
    getAiClient(ctx.userId),
    getJiraSettings(ctx.userId),
    getAiTicketSettings(ctx.userId),
  ]);
  if (!ai) {
    ctx.onError('No AI provider configured. Open Settings (⚙) on desktop → AI assistant.');
    return true;
  }
  if (!jiraIsConfigured(jira)) {
    ctx.onError('Jira is not configured. Open Settings (⚙) on desktop → Jira.');
    return true;
  }
  const projectKey = (jira.defaultProject || '').toUpperCase();
  if (!projectKey) {
    ctx.onError('No default Jira project set. Open Settings (⚙) on desktop → Jira → Default project.');
    return true;
  }
  ctx.onAiThinking(true);
  let aiResult;
  try {
    const ctxNote = (aiTicket?.context || '').trim();
    const system = ctxNote ? `## Project context (always applies)\n${ctxNote}\n\n---\n\n${TICKET_SYSTEM_PROMPT}` : TICKET_SYSTEM_PROMPT;
    aiResult = await ai.chat({ system, messages: [{ role: 'user', content: prompt }] });
  } catch (err) {
    ctx.onAiThinking(false);
    ctx.onError(`AI request failed: ${(err as Error)?.message ?? String(err)}`);
    return true;
  }
  ctx.onAiThinking(false);
  let parsed;
  try {
    parsed = parseTicketJson(aiResult.text);
  } catch (err) {
    ctx.onError(`AI returned an unparseable response: ${(err as Error)?.message ?? String(err)}`);
    return true;
  }
  if (!parsed.summary) {
    ctx.onError('AI did not produce a ticket summary. Try rephrasing the description.');
    return true;
  }
  const summary = parsed.summary.slice(0, 250);
  let issue;
  try {
    issue = await createJiraIssue(jira, projectKey, summary, parsed.description || '', parsed.issueType || 'Task');
  } catch (err) {
    ctx.onError(`Could not create Jira ticket: ${(err as Error)?.message ?? String(err)}`);
    return true;
  }
  await sendMessage({
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    authorId: ctx.userId,
    body: issue.url,
    aiGenerated: true,
    aiModel: aiResult.model,
  });
  return true;
}

async function runSummarize(ctx: SlashContext): Promise<boolean> {
  const ai = await getAiClient(ctx.userId);
  if (!ai) {
    ctx.onError('No AI provider configured. Open Settings (⚙) on desktop → AI assistant.');
    return true;
  }
  // Take last 100 visible top-level messages (no thread filter — mobile
  // doesn't have a threads UI yet).
  const top = ctx.recentMessages.filter((m) => !m.parent_id).slice(-100);
  if (top.length === 0) {
    ctx.onError('Nothing to summarize yet.');
    return true;
  }
  const nameFor = (uid: string) => ctx.roster.find((p) => p.user_id === uid)?.name || 'someone';
  const marshalled = top.map((m) => ({ text: m.body, ts: m.ts, authorName: nameFor(m.author_id) }));
  ctx.onAiThinking(true);
  let result;
  try {
    result = await aiSummarize(ai, marshalled);
  } catch (err) {
    ctx.onAiThinking(false);
    ctx.onError(`AI request failed: ${(err as Error)?.message ?? String(err)}`);
    return true;
  }
  ctx.onAiThinking(false);
  const body = `**Channel summary (last ${top.length} messages)**\n\n${result.text || '(no response)'}`;
  await sendMessage({
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    authorId: ctx.userId,
    body,
    aiGenerated: true,
    aiModel: result.model,
  });
  return true;
}

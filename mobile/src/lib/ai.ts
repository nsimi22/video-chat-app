// Mobile AI client — port of renderer/ai.js.
//
// The desktop client routes through window.huddle.fetchProxy because the
// renderer is subject to CORS. React Native's native fetch is not, so we hit
// api.anthropic.com / openrouter.ai directly. Same provider semantics, same
// settings shape, same tool-use loop.
//
// Settings live in public.user_integrations.settings.ai:
//   { provider, anthropicKey, anthropicModel, openrouterKey, openrouterModel }

export type AiProvider = 'anthropic' | 'openrouter';

export type AiSettings = {
  provider?: AiProvider;
  anthropicKey?: string;
  anthropicModel?: string;
  openrouterKey?: string;
  openrouterModel?: string;
};

const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';
const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-opus-4-7';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type ChatArgs = {
  system?: string;
  messages: ChatMessage[];
  model?: string;
  tools?: ToolDef[];
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  maxIterations?: number;
};

export type ChatResult = {
  text: string;
  model: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
};

export class AiClient {
  provider: AiProvider;
  anthropicKey: string;
  openrouterKey: string;
  defaultModel: string;

  constructor(s: AiSettings) {
    this.provider = s.provider === 'openrouter' ? 'openrouter' : 'anthropic';
    this.anthropicKey = s.anthropicKey || '';
    this.openrouterKey = s.openrouterKey || '';
    this.defaultModel =
      (this.provider === 'anthropic' ? s.anthropicModel : s.openrouterModel) ||
      (this.provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENROUTER_DEFAULT_MODEL);
  }

  isConfigured(): boolean {
    return this.provider === 'anthropic' ? !!this.anthropicKey : !!this.openrouterKey;
  }

  async chat(args: ChatArgs): Promise<ChatResult> {
    if (!this.isConfigured()) throw new Error('AI provider not configured — open Settings on desktop to add an API key.');
    const model = args.model || this.defaultModel;
    const tools = Array.isArray(args.tools) && args.tools.length > 0 ? args.tools : null;
    const maxIterations = args.maxIterations ?? 8;
    return this.provider === 'anthropic'
      ? this._anthropic({ ...args, model, tools, maxIterations })
      : this._openrouter({ ...args, model, tools, maxIterations });
  }

  private async _anthropic(args: Omit<ChatArgs, 'tools'> & { model: string; tools: ToolDef[] | null; maxIterations: number }): Promise<ChatResult> {
    const apiTools = args.tools
      ? args.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
      : null;
    const toolUses: ChatResult['toolUses'] = [];
    const convo: Array<{ role: string; content: unknown }> = args.messages.map((m) => ({ role: m.role, content: m.content }));
    for (let i = 0; i < args.maxIterations; i++) {
      const lastRound = i === args.maxIterations - 1;
      const body: Record<string, unknown> = {
        model: args.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        messages: convo,
        ...(args.system ? { system: args.system } : {}),
        ...(apiTools ? { tools: apiTools, ...(lastRound ? { tool_choice: { type: 'none' } } : {}) } : {}),
      };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${parseProviderError(text)}`);
      const json = JSON.parse(text);
      const blocks: Array<{ type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }> = json.content || [];
      const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
      if (!apiTools || lastRound || toolBlocks.length === 0) {
        const outText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        return { text: outText, model: args.model, toolUses };
      }
      convo.push({ role: 'assistant', content: blocks });
      const results: Array<Record<string, unknown>> = [];
      for (const tu of toolBlocks) {
        const def = args.tools!.find((t) => t.name === tu.name);
        let resultText: string;
        let isError = false;
        try {
          if (!def) throw new Error(`unknown tool: ${tu.name}`);
          args.onToolUse?.(tu.name!, tu.input || {});
          toolUses.push({ name: tu.name!, input: tu.input || {} });
          const out = await def.run(tu.input || {});
          resultText = typeof out === 'string' ? out : JSON.stringify(out);
        } catch (err) {
          resultText = String((err as Error)?.message || err);
          isError = true;
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText, ...(isError ? { is_error: true } : {}) });
      }
      convo.push({ role: 'user', content: results });
    }
    throw new Error(`AI tool-use loop exceeded ${args.maxIterations} iterations`);
  }

  private async _openrouter(args: Omit<ChatArgs, 'tools'> & { model: string; tools: ToolDef[] | null; maxIterations: number }): Promise<ChatResult> {
    const apiTools = args.tools
      ? args.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }))
      : null;
    const toolUses: ChatResult['toolUses'] = [];
    const convo: Array<Record<string, unknown>> = args.system
      ? [{ role: 'system', content: args.system }, ...args.messages.map((m) => ({ role: m.role, content: m.content }))]
      : args.messages.map((m) => ({ role: m.role, content: m.content }));
    for (let i = 0; i < args.maxIterations; i++) {
      const lastRound = i === args.maxIterations - 1;
      const body: Record<string, unknown> = {
        model: args.model,
        messages: convo,
        ...(apiTools ? { tools: apiTools, ...(lastRound ? { tool_choice: 'none' } : {}) } : {}),
      };
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.openrouterKey}`,
          'content-type': 'application/json',
          'X-Title': 'Huddle',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${parseProviderError(text)}`);
      const json = JSON.parse(text);
      const message = json.choices?.[0]?.message || {};
      const calls: Array<{ id: string; function: { name: string; arguments: string } }> = message.tool_calls || [];
      if (!apiTools || lastRound || calls.length === 0) {
        return { text: message.content || '', model: args.model, toolUses };
      }
      convo.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        let input: Record<string, unknown> = {};
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = {};
        }
        const def = args.tools!.find((t) => t.name === name);
        let resultText: string;
        try {
          if (!def) throw new Error(`unknown tool: ${name}`);
          args.onToolUse?.(name, input);
          toolUses.push({ name, input });
          const out = await def.run(input);
          resultText = typeof out === 'string' ? out : JSON.stringify(out);
        } catch (err) {
          resultText = `error: ${(err as Error)?.message || err}`;
        }
        convo.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      }
    }
    throw new Error(`AI tool-use loop exceeded ${args.maxIterations} iterations`);
  }
}

// Convenience used by /summarize. Mirrors renderer/ai.js .summarize().
export async function summarize(
  client: AiClient,
  msgs: Array<{ text: string; ts: string; authorName: string }>,
  topicHint?: string,
): Promise<ChatResult> {
  const system =
    'You are a meeting / chat summarizer. Produce a tight, scannable summary of recent messages in a team chat. Use bullet points. Capture decisions, open questions, and any action items (with owners if you can infer them). Keep it under 250 words.';
  const lines = (msgs || [])
    .filter((m) => m.text)
    .map((m) => {
      const ts = new Date(m.ts || Date.now()).toISOString().slice(11, 16);
      const who = m.authorName || 'someone';
      return `[${ts}] ${who}: ${m.text.replace(/\n+/g, ' ')}`;
    })
    .join('\n');
  const user = (topicHint ? `Topic: ${topicHint}\n\n` : '') + `Transcript:\n${lines || '(no messages)'}`;
  return client.chat({ system, messages: [{ role: 'user', content: user }] });
}

function parseProviderError(body: string): string {
  try {
    const j = JSON.parse(body);
    return j.error?.message || j.error?.type || j.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

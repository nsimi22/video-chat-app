// Unified AI client — Claude direct (Anthropic API) and OpenRouter.
//
// Both providers go through window.huddle.fetchProxy so requests originate
// from the Electron main process: the renderer's CORS rules don't apply to
// Anthropic's API (which discourages browser-direct calls), and keys never
// leak to a third-party origin via fetch.
//
// Defaults follow Claude API skill guidance:
//   - Anthropic provider: model = `claude-opus-4-7`, adaptive thinking
//   - OpenRouter provider: model = `anthropic/claude-opus-4-7` (same model,
//     billed via OpenRouter — useful for users who already have credits there
//     or want easy fallback to other providers from the same key)
//
// Public surface:
//   - new AiClient({ provider, anthropicKey, openrouterKey, defaultModel })
//   - .isConfigured()
//   - .chat({ system, messages, model }) -> { text, model, usage }
//   - .summarize(channelMessages, instructions) -> { text, model, usage }

(function () {
  const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';
  const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-opus-4-7';

  class AiClient {
    constructor({ provider, anthropicKey, openrouterKey, defaultModel } = {}) {
      this.provider = provider === 'openrouter' ? 'openrouter' : 'anthropic';
      this.anthropicKey = anthropicKey || '';
      this.openrouterKey = openrouterKey || '';
      this.defaultModel = defaultModel
        || (this.provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENROUTER_DEFAULT_MODEL);
    }

    isConfigured() {
      return this.provider === 'anthropic' ? !!this.anthropicKey : !!this.openrouterKey;
    }

    /**
     * @param {Object} args
     * @param {string} [args.system] — system prompt
     * @param {Array<{role:'user'|'assistant',content:string}>} args.messages
     * @param {string} [args.model] — override default model
     * @param {Array<{name:string,description:string,input_schema:object,run:Function}>} [args.tools]
     *   Tools follow Anthropic's shape; `run(input)` is called when the
     *   model asks to invoke the tool. Each `run` returns either a
     *   string or a JSON-serializable object — both are stringified
     *   before being sent back as a tool_result.
     * @param {(name:string,input:object)=>void} [args.onToolUse] — fired each
     *   time the model calls a tool, before `run` executes. Useful for
     *   typing-indicator UI ("AI is fetching FOO-123…").
     * @param {number} [args.maxIterations=8] — cap on tool-use rounds to
     *   stop runaway loops.
     * @returns {Promise<{text:string, model:string, usage:Object, toolUses:Array}>}
     */
    async chat({ system, messages, model, tools, onToolUse, maxIterations = 8 }) {
      if (!this.isConfigured()) {
        throw new Error('AI provider not configured — open Settings to add an API key.');
      }
      const effectiveModel = model || this.defaultModel;
      // Empty arrays trip Anthropic's "tools must contain at least 1
      // entry" validator — treat empty/undefined the same way and skip
      // the tool-use loop entirely.
      const realTools = Array.isArray(tools) && tools.length > 0 ? tools : null;
      const args = { system, messages: messages.slice(), model: effectiveModel, tools: realTools, onToolUse, maxIterations };
      return this.provider === 'anthropic' ? this._anthropicChat(args) : this._openrouterChat(args);
    }

    async _anthropicChat({ system, messages, model, tools, onToolUse, maxIterations }) {
      // Adaptive thinking: model decides how much to think per request.
      // 16k max_tokens keeps non-streaming responses under SDK timeouts.
      // Tool-use loop: when `tools` is provided, each /v1/messages call
      // can return tool_use blocks instead of text. Execute them, append
      // a {role:'user', content:[tool_result …]} message, repeat until
      // the model returns end_turn (or we hit maxIterations).
      const apiTools = tools ? tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })) : null;
      const usage = { input_tokens: 0, output_tokens: 0 };
      const toolUses = [];
      const convo = messages.slice();
      for (let i = 0; i < maxIterations; i++) {
        // On the last allowed round, force a text answer instead of
        // failing the request: keep the tools *declared* (the API wants
        // every tool referenced in the history to stay defined) but set
        // tool_choice:none so the model can't ask for yet another call —
        // it has to answer with whatever it's already gathered.
        const lastRound = i === maxIterations - 1;
        const body = {
          model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          messages: convo,
          ...(system ? { system } : {}),
          ...(apiTools ? { tools: apiTools, ...(lastRound ? { tool_choice: { type: 'none' } } : {}) } : {}),
        };
        const res = await window.huddle.fetchProxy({
          url: 'https://api.anthropic.com/v1/messages',
          method: 'POST',
          headers: {
            'x-api-key': this.anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res || !res.ok) {
          throw new Error(`Anthropic ${res?.status || 0}: ${parseProviderError(res?.body) || res?.error || 'request failed'}`);
        }
        const json = JSON.parse(res.body);
        if (json.usage) {
          usage.input_tokens += json.usage.input_tokens || 0;
          usage.output_tokens += json.usage.output_tokens || 0;
        }
        const blocks = json.content || [];
        // No tools or model said end_turn → done. Anthropic distinguishes
        // these via stop_reason, but checking for tool_use blocks is
        // equivalent and avoids depending on the literal value.
        const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
        if (!apiTools || lastRound || toolBlocks.length === 0) {
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          return { text, model, usage, toolUses };
        }
        // Append the assistant's full content (text + tool_use) as-is
        // so the next turn has the matching tool_use ids the API
        // requires. Then run each tool and emit a tool_result block per
        // call inside a single user message, in the same order.
        convo.push({ role: 'assistant', content: blocks });
        const results = [];
        for (const tu of toolBlocks) {
          const toolDef = tools.find((t) => t.name === tu.name);
          let resultText, isError = false;
          try {
            if (!toolDef) throw new Error(`unknown tool: ${tu.name}`);
            onToolUse?.(tu.name, tu.input || {});
            toolUses.push({ name: tu.name, input: tu.input || {} });
            const out = await toolDef.run(tu.input || {});
            // Anthropic requires tool_result.content to be a string —
            // an undefined return (or JSON.stringify(undefined)) would
            // drop the field and trip a 400.
            resultText = (typeof out === 'string' ? out : JSON.stringify(out)) ?? '';
          } catch (err) {
            resultText = String(err?.message || err);
            isError = true;
          }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText, ...(isError ? { is_error: true } : {}) });
        }
        convo.push({ role: 'user', content: results });
      }
      // Unreachable for maxIterations >= 1 (the final round forces a text
      // answer and so always returns); kept as a guard against a 0/neg cap.
      throw new Error(`AI tool-use loop exceeded ${maxIterations} iterations`);
    }

    async _openrouterChat({ system, messages, model, tools, onToolUse, maxIterations }) {
      // OpenAI-style function calling. Translate Anthropic-shaped tool
      // defs (`name/description/input_schema`) into the OpenAI shape
      // (`type:function, function:{name,description,parameters}`) so
      // callers ship one definition for both providers.
      const apiTools = tools ? tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })) : null;
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      const toolUses = [];
      const convo = system ? [{ role: 'system', content: system }, ...messages] : messages.slice();
      for (let i = 0; i < maxIterations; i++) {
        // Last allowed round: keep tools declared but tool_choice:'none'
        // so the model must answer rather than ask for another call —
        // avoids both a hard failure and the "tool_calls in history but
        // no tools defined" error some providers raise (see _anthropicChat).
        const lastRound = i === maxIterations - 1;
        const body = { model, messages: convo, ...(apiTools ? { tools: apiTools, ...(lastRound ? { tool_choice: 'none' } : {}) } : {}) };
        const res = await window.huddle.fetchProxy({
          url: 'https://openrouter.ai/api/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.openrouterKey}`,
            'content-type': 'application/json',
            // X-Title surfaces the app name on OpenRouter's dashboard. We
            // intentionally don't send HTTP-Referer — it's optional, and
            // hardcoding any URL here would either leak a fork's source repo
            // or misrepresent the deployment.
            'X-Title': 'Huddle',
          },
          body: JSON.stringify(body),
        });
        if (!res || !res.ok) {
          throw new Error(`OpenRouter ${res?.status || 0}: ${parseProviderError(res?.body) || res?.error || 'request failed'}`);
        }
        const json = JSON.parse(res.body);
        if (json.usage) {
          usage.prompt_tokens += json.usage.prompt_tokens || 0;
          usage.completion_tokens += json.usage.completion_tokens || 0;
        }
        const message = json.choices?.[0]?.message || {};
        const calls = message.tool_calls || [];
        if (!apiTools || lastRound || calls.length === 0) {
          return { text: message.content || '', model, usage, toolUses };
        }
        // Echo the assistant's tool_calls back so the next request has
        // matching ids. The OpenAI schema expects content === null (not
        // '') when tool_calls are present — strict OR proxies reject
        // the empty-string variant.
        convo.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
        for (const call of calls) {
          const name = call.function?.name;
          let input = {};
          try { input = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { input = {}; }
          const toolDef = tools.find((t) => t.name === name);
          let resultText;
          try {
            if (!toolDef) throw new Error(`unknown tool: ${name}`);
            onToolUse?.(name, input);
            toolUses.push({ name, input });
            const out = await toolDef.run(input);
            // OpenAI tool message requires content as a string — guard
            // against an undefined return / JSON.stringify(undefined).
            resultText = (typeof out === 'string' ? out : JSON.stringify(out)) ?? '';
          } catch (err) {
            resultText = `error: ${err?.message || err}`;
          }
          convo.push({ role: 'tool', tool_call_id: call.id, content: resultText });
        }
      }
      // Unreachable for maxIterations >= 1 (see _anthropicChat).
      throw new Error(`AI tool-use loop exceeded ${maxIterations} iterations`);
    }

    // Convenience: build a system+user prompt from a list of recent chat
    // messages and ask the model to summarize. The shape lives here (rather
    // than in chat.js) so the prompt stays close to the API surface.
    // Caller passes the marshalled message shape from chat.js (`{text, ts,
    // authorName}`) — see HuddleClient._marshalMessage. The `m.ts` fallback
    // to `Date.now()` is purely defensive: `new Date(undefined).toISOString()`
    // throws RangeError, and this loop is too far from the API boundary to
    // want to crash on a malformed row.
    async summarize(channelMessages, { topicHint } = {}) {
      // The human-readable summary is unchanged; we *additionally* ask for
      // a machine-readable action-items block at the very end so the
      // renderer can turn each item into a one-click "Create ticket" row
      // (see action-items.js). Keeping the prose intact means the message
      // still reads fine even where the structured block isn't parsed
      // (search, notifications, the mobile app).
      //
      // The structured action-items instruction is defined once, next to
      // the parser that consumes it (action-items.js → window.ACTION_ITEMS_PROMPT).
      // Reference it at runtime rather than keeping a duplicate literal here
      // that could drift. action-items.js is loaded before any summarize()
      // call, so the global is reliably present; fall back to '' defensively
      // so a load-order surprise just drops the block instead of throwing.
      const actionItemsPrompt = window.ACTION_ITEMS_PROMPT || '';
      const system = `You are a meeting / chat summarizer. Produce a tight, scannable summary of recent messages in a team chat. Use bullet points. Capture decisions, open questions, and any action items (with owners if you can infer them). Keep it under 250 words.\n\n${actionItemsPrompt}`;
      const lines = (channelMessages || [])
        .filter((m) => m.text)
        .map((m) => {
          const ts = new Date(m.ts || Date.now()).toISOString().slice(11, 16);
          const who = m.authorName || 'someone';
          const txt = m.text.replace(/\n+/g, ' ');
          return `[${ts}] ${who}: ${txt}`;
        })
        .join('\n');
      const user = (topicHint ? `Topic: ${topicHint}\n\n` : '') + `Transcript:\n${lines || '(no messages)'}`;
      return this.chat({
        system,
        messages: [{ role: 'user', content: user }],
      });
    }
  }

  function parseProviderError(body) {
    if (!body) return '';
    try {
      const j = JSON.parse(body);
      return j.error?.message || j.error?.type || j.message || body.slice(0, 200);
    } catch { return body.slice(0, 200); }
  }

  window.AiClient = AiClient;
  window.AI_DEFAULT_MODELS = {
    anthropic: ANTHROPIC_DEFAULT_MODEL,
    openrouter: OPENROUTER_DEFAULT_MODEL,
  };
})();

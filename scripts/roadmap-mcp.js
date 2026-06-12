#!/usr/bin/env node
// MCP server for the Huddle team roadmap (public.team_roadmap_items).
//
// Lets an MCP client — Claude Code via the checked-in .mcp.json, or anything
// else speaking MCP over stdio — create, update, and delete the ad-hoc bars
// on the board's Timeline/Feed views (plus list, so updates/deletes can be
// targeted). Writes land in Supabase and appear LIVE in every open Huddle
// window through the table's existing realtime publication.
//
// Hand-rolled stdio transport (newline-delimited JSON-RPC) rather than the
// MCP SDK: the server needs four methods (initialize / tools/list /
// tools/call / ping) and zero new dependencies this way — @supabase/supabase-js
// is already in package.json.
//
// Configuration (env):
//   HUDDLE_TEAM_ID               required — the team whose roadmap to operate on
//   HUDDLE_SUPABASE_URL          optional — defaults to the provisioned project
//                                (same convention as main.js)
//   Auth, one of:
//   HUDDLE_EMAIL + HUDDLE_PASSWORD     sign in as a real user: RLS enforced,
//                                      created_by/updated_by attributed to you
//   HUDDLE_SUPABASE_SERVICE_KEY        service role: bypasses RLS (rows are
//                                      unattributed) — prefer the user mode
//
// Run standalone for a smoke test:
//   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node scripts/roadmap-mcp.js

// Required lazily (inside db()) so a missing node_modules surfaces as a
// readable tool-call error instead of a dead server at startup.
function loadSupabase() {
  try { return require('@supabase/supabase-js'); }
  catch { throw new Error("@supabase/supabase-js is not installed — run `npm install` in the repo root first."); }
}

const SUPABASE_URL = process.env.HUDDLE_SUPABASE_URL
  || 'https://jwqvrdgjpftjiwvgdrck.supabase.co';
// The publishable (anon) key — safe to embed, same one main.js ships.
const PUBLISHABLE_KEY = process.env.HUDDLE_SUPABASE_KEY
  || 'sb_publishable_5eJWwJEHWHSLuhFEs2iUlw_tu4fGOvn';
const SERVICE_KEY = process.env.HUDDLE_SUPABASE_SERVICE_KEY || '';
const EMAIL = process.env.HUDDLE_EMAIL || '';
const PASSWORD = process.env.HUDDLE_PASSWORD || '';
const TEAM_ID = process.env.HUDDLE_TEAM_ID || '';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Mirror the renderer's allow-list (jira-board.js ADHOC_COLORS) so a color
// set here always renders.
const COLORS = ['accent-2', 'good', 'warn', 'bad'];

let _db = null; // lazily connected + signed in on first tool call
async function db() {
  if (_db) return _db;
  if (!TEAM_ID) throw new Error('HUDDLE_TEAM_ID is not set — export the team id this roadmap belongs to.');
  const { createClient } = loadSupabase();
  if (SERVICE_KEY) {
    _db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    return _db;
  }
  if (!EMAIL || !PASSWORD) {
    throw new Error('No credentials: set HUDDLE_EMAIL + HUDDLE_PASSWORD (preferred) or HUDDLE_SUPABASE_SERVICE_KEY.');
  }
  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) throw new Error(`Supabase sign-in failed: ${error.message}`);
  _db = client;
  return _db;
}

// ── field validation (mirrors the table's CHECK constraints so errors are
//    actionable instead of raw Postgres) ──
function vTitle(title) {
  const t = String(title || '').trim();
  if (!t) throw new Error('title is required');
  if (t.length > 200) throw new Error('title must be 200 characters or fewer');
  return t;
}
function vDate(v, name) {
  if (v == null) return null;
  if (!DATE_RE.test(String(v))) throw new Error(`${name} must be YYYY-MM-DD (got "${v}")`);
  return String(v);
}
function vColor(v) {
  if (v == null) return null;
  if (!COLORS.includes(v)) throw new Error(`color must be one of ${COLORS.join(', ')} (or null)`);
  return v;
}
function vRange(start, end) {
  if (start && end && end < start) throw new Error(`end_date (${end}) is before start_date (${start})`);
}

const ROW_COLS = 'id, title, start_date, end_date, color, notes, created_at, updated_at';

const TOOLS = [
  {
    name: 'roadmap_list',
    description: "List the team's ad-hoc roadmap items (the hand-added bars on Huddle's board Timeline/Feed views — separate from Jira epics). Returns id, title, start_date, end_date (target/ship date), color, notes, and timestamps, ordered by start date with undated items last. Use this to find an item's id before updating or deleting it.",
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { data, error } = await (await db())
        .from('team_roadmap_items').select(ROW_COLS).eq('team_id', TEAM_ID)
        .order('start_date', { ascending: true, nullsFirst: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
  },
  {
    name: 'roadmap_create',
    description: "Add an item to the team roadmap. It appears live on every teammate's board. Dates are optional ISO YYYY-MM-DD (end_date is the target/ship date; an item with no end_date renders open-ended, with no dates at all it parks at today). Omit dates you were not given rather than inventing them.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Deliverable title, 1-200 chars.' },
        start_date: { type: 'string', description: 'Optional start date, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'Optional target/ship date, YYYY-MM-DD.' },
        color: { type: 'string', enum: COLORS, description: 'Optional accent token for the bar.' },
        notes: { type: 'string', description: 'Optional context. A GitHub URL or owner/repo#123 here renders a live PR/issue status chip on the bar.' },
      },
      required: ['title'],
    },
    async run(a) {
      const row = {
        team_id: TEAM_ID,
        title: vTitle(a.title),
        start_date: vDate(a.start_date, 'start_date'),
        end_date: vDate(a.end_date, 'end_date'),
        color: vColor(a.color),
        notes: a.notes ? String(a.notes) : null,
      };
      vRange(row.start_date, row.end_date);
      const { data, error } = await (await db())
        .from('team_roadmap_items').insert(row).select(ROW_COLS).single();
      if (error) throw new Error(error.message);
      return data;
    },
  },
  {
    name: 'roadmap_update',
    description: 'Update fields on an existing roadmap item by id (from roadmap_list). Pass only the fields to change; pass null explicitly to clear start_date / end_date / color / notes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (uuid) from roadmap_list.' },
        title: { type: 'string', description: 'New title, 1-200 chars.' },
        start_date: { type: ['string', 'null'], description: 'New start date YYYY-MM-DD, or null to clear.' },
        end_date: { type: ['string', 'null'], description: 'New target date YYYY-MM-DD, or null to clear.' },
        color: { type: ['string', 'null'], enum: [...COLORS, null], description: 'New accent token, or null for default.' },
        notes: { type: ['string', 'null'], description: 'New notes, or null to clear.' },
      },
      required: ['id'],
    },
    async run(a) {
      if (!a.id) throw new Error('id is required');
      const client = await db();
      // Fetch-then-merge so a one-sided date change is validated against the
      // other date before Postgres rejects it with a bare CHECK error.
      const { data: cur, error: getErr } = await client
        .from('team_roadmap_items').select(ROW_COLS).eq('team_id', TEAM_ID).eq('id', a.id).maybeSingle();
      if (getErr) throw new Error(getErr.message);
      if (!cur) throw new Error(`No roadmap item with id ${a.id} on this team.`);
      const patch = {};
      if ('title' in a) patch.title = vTitle(a.title);
      if ('start_date' in a) patch.start_date = vDate(a.start_date, 'start_date');
      if ('end_date' in a) patch.end_date = vDate(a.end_date, 'end_date');
      if ('color' in a) patch.color = vColor(a.color);
      if ('notes' in a) patch.notes = a.notes == null ? null : String(a.notes);
      if (!Object.keys(patch).length) throw new Error('Pass at least one field to change.');
      vRange('start_date' in patch ? patch.start_date : cur.start_date,
        'end_date' in patch ? patch.end_date : cur.end_date);
      const { data, error } = await client
        .from('team_roadmap_items').update(patch)
        .eq('team_id', TEAM_ID).eq('id', a.id).select(ROW_COLS).single();
      if (error) throw new Error(error.message);
      return data;
    },
  },
  {
    name: 'roadmap_delete',
    description: 'Delete a roadmap item by id (from roadmap_list). Removes it from every teammate\'s board immediately. There is no undo — list first and be sure.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The item id (uuid) to delete.' } },
      required: ['id'],
    },
    async run(a) {
      if (!a.id) throw new Error('id is required');
      const { data, error } = await (await db())
        .from('team_roadmap_items').delete()
        .eq('team_id', TEAM_ID).eq('id', a.id).select('id, title');
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error(`No roadmap item with id ${a.id} on this team.`);
      return { deleted: true, id: data[0].id, title: data[0].title };
    },
  },
];

/* ── stdio JSON-RPC loop (MCP transport: one JSON message per line) ── */
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; } // not JSON — ignore
  const { id, method, params } = msg;
  // Notifications (no id) never get a response per JSON-RPC.
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'huddle-roadmap', version: '1.0.0' },
      });
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      // initialized / cancelled — nothing to do
    } else if (method === 'ping') {
      reply({});
    } else if (method === 'tools/list') {
      reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
      // Tool failures are results (isError), not protocol errors — the model
      // should see the message and adjust, not have the call vanish.
      try {
        const out = await tool.run(params?.arguments || {});
        reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        reply({ content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true });
      }
    } else {
      fail(-32601, `method not found: ${method}`);
    }
  } catch (err) {
    fail(-32603, String((err && err.message) || err));
  }
}

// Exit when stdin closes — but only after in-flight tool calls have
// written their replies, so a client that half-closes (or a piped smoke
// test) doesn't lose responses to slow async calls.
let buf = '';
let pending = 0;
let ended = false;
function maybeExit() { if (ended && pending === 0) process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    pending++;
    handle(line).finally(() => { pending--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });

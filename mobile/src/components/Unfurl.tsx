import React, { useEffect, useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { colors, radius, space } from '@/theme';
import { extractJiraRefs, fetchJiraIssue, jiraIssueUrl, type JiraIssue } from '@/lib/jira';
import { extractGithubRefs, fetchGithubIssueOrPull, fetchGithubPullSummary, type GithubIssue, type GithubPullSummary } from '@/lib/github';
import { getJiraSettings, getGithubSettings } from '@/lib/integrations';

// Tiny inline cards rendered below a chat body. The viewer uses *their own*
// credentials to fetch metadata (same model as desktop renderer/chat.js: each
// teammate sees only the tickets / repos their PAT or token can see).
//
// Fetches are deduped via a process-wide cache so a channel full of links to
// the same ticket only hits the API once. The cache key includes the viewer
// id — a sign-out → sign-in on the same device must NOT serve user A's
// cached titles to user B (B's credentials might not have access to them).
// Failed fetches (null) are evicted so a later send/redraw can retry instead
// of staying broken for the rest of the app's lifetime.

type JiraCache = { [k: string]: Promise<JiraIssue | null> };
type GhCache = { [k: string]: Promise<GithubIssue | null> };
const jiraCache: JiraCache = {};
const ghCache: GhCache = {};
// PR check/merge/review summaries, keyed the same way as ghCache (incl.
// viewer id) so the extra lookup is shared across duplicate links.
const ghPrCache: { [k: string]: Promise<GithubPullSummary | null> } = {};

function jiraKey(viewerId: string, host: string | undefined, key: string) { return `${viewerId}::${host ?? '_'}::${key}`; }
function ghKey(viewerId: string, owner: string, repo: string, number: string) { return `${viewerId}::${owner}/${repo}#${number}`; }

async function cachedFetch<T>(cache: { [k: string]: Promise<T | null> }, key: string, fetcher: () => Promise<T | null>): Promise<T | null> {
  if (!cache[key]) cache[key] = fetcher();
  const v = await cache[key];
  if (v === null) delete cache[key]; // let the next attempt retry instead of pinning the failure
  return v;
}

function jiraStatusColor(category?: string) {
  // Atlassian's status category keys: 'new' (todo), 'indeterminate' (in
  // progress), 'done'.
  if (category === 'done') return '#34c759';
  if (category === 'indeterminate') return '#5b8cff';
  return colors.textDim;
}

function JiraCard({ issue }: { issue: JiraIssue }) {
  const status = issue.fields.status?.name ?? '';
  const statusCat = issue.fields.status?.statusCategory?.key;
  const type = issue.fields.issuetype?.name ?? 'Issue';
  const assignee = issue.fields.assignee?.displayName;
  return (
    <TouchableOpacity
      onPress={() => Linking.openURL(jiraIssueUrl(issue.host, issue.key)).catch(() => {})}
      style={{
        marginTop: space(1.5),
        borderLeftWidth: 3,
        borderLeftColor: colors.accent,
        backgroundColor: colors.surface,
        borderRadius: radius.sm,
        paddingVertical: space(2),
        paddingHorizontal: space(3),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
        <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '600', letterSpacing: 0.3 }}>
          {issue.key}  ·  {type}
        </Text>
      </View>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }} numberOfLines={2}>
        {issue.fields.summary || '(no summary)'}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
        {status ? (
          <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: jiraStatusColor(statusCat), marginRight: 6 }}>
            <Text style={{ color: jiraStatusColor(statusCat), fontSize: 11, fontWeight: '600' }}>{status}</Text>
          </View>
        ) : null}
        {assignee ? (
          <Text style={{ color: colors.textDim, fontSize: 12 }}>{assignee}</Text>
        ) : (
          <Text style={{ color: colors.textDim, fontSize: 12, fontStyle: 'italic' }}>unassigned</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function ghStateColor(state: string, mergedAt?: string | null) {
  if (mergedAt) return '#a371f7';     // merged purple
  if (state === 'closed') return '#ff5b5b';
  return '#34c759';                    // open green
}
function ghStateLabel(issue: GithubIssue) {
  if (issue.pull_request?.merged_at) return 'merged';
  return issue.state;
}

// A tiny outlined pill matching the Jira/GitHub card status chips.
function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: color, marginRight: 6, marginTop: 4 }}>
      <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

const PILL_GREEN = '#34c759';
const PILL_RED = '#ff5b5b';
const PILL_AMBER = '#ff9f0a';

// The PR detail pills (checks / mergeable / review), computed from a summary.
function prPills(s: GithubPullSummary, viewerId: string): React.ReactElement[] {
  const pills: React.ReactElement[] = [];
  const c = s.checks;
  if (c.total > 0) {
    if (c.rollup === 'failure') pills.push(<Pill key="chk" text={`✕ ${c.passed}/${c.total} checks`} color={PILL_RED} />);
    else if (c.rollup === 'pending') pills.push(<Pill key="chk" text={`● ${c.passed}/${c.total} checks`} color={PILL_AMBER} />);
    else pills.push(<Pill key="chk" text={`✓ ${c.total} checks`} color={PILL_GREEN} />);
  }
  if (s.draft) pills.push(<Pill key="mrg" text="draft" color={colors.textDim} />);
  else if (s.mergeable === false || s.mergeableState === 'dirty') pills.push(<Pill key="mrg" text="conflicts" color={PILL_RED} />);
  else if (s.mergeableState === 'blocked') pills.push(<Pill key="mrg" text="blocked" color={PILL_AMBER} />);
  else if (s.mergeable === true) pills.push(<Pill key="mrg" text="mergeable" color={PILL_GREEN} />);
  const r = s.review;
  if (r.decision === 'changes_requested') pills.push(<Pill key="rev" text="changes requested" color={PILL_RED} />);
  else if (r.decision === 'approved') pills.push(<Pill key="rev" text={`approved${r.approvals > 1 ? ` ×${r.approvals}` : ''}`} color={PILL_GREEN} />);
  else if (r.decision === 'review_required') pills.push(<Pill key="rev" text="review required" color={PILL_AMBER} />);
  // viewerId is unused here but kept in the signature so a future
  // "reviewed by you" nuance can key off it without a churny refactor.
  void viewerId;
  return pills;
}

function GitHubCard({ issue, viewerId }: { issue: GithubIssue; viewerId: string }) {
  const isPr = !!issue.pull_request;
  const state = ghStateLabel(issue);
  const stateColor = ghStateColor(issue.state, issue.pull_request?.merged_at ?? null);

  // Only open PRs get the extra checks/merge/review lookup — a merged or
  // closed PR's CI + review state is just history.
  const wantDetails = isPr && issue.state === 'open';
  const [summary, setSummary] = useState<GithubPullSummary | null>(null);
  useEffect(() => {
    if (!wantDetails) { setSummary(null); return; }
    let active = true;
    (async () => {
      const s = await getGithubSettings(viewerId);
      if (!s) return;
      const key = ghKey(viewerId, issue.owner, issue.repo, String(issue.number));
      const res = await cachedFetch(ghPrCache, key, () => fetchGithubPullSummary(s, issue.owner, issue.repo, issue.number));
      if (active) setSummary(res);
    })();
    return () => { active = false; };
  }, [wantDetails, viewerId, issue.owner, issue.repo, issue.number]);

  return (
    <TouchableOpacity
      onPress={() => Linking.openURL(issue.html_url).catch(() => {})}
      style={{
        marginTop: space(1.5),
        borderLeftWidth: 3,
        borderLeftColor: stateColor,
        backgroundColor: colors.surface,
        borderRadius: radius.sm,
        paddingVertical: space(2),
        paddingHorizontal: space(3),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
        <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '600', letterSpacing: 0.3 }}>
          {issue.owner}/{issue.repo}#{issue.number}  ·  {isPr ? 'PR' : 'Issue'}
        </Text>
      </View>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }} numberOfLines={2}>
        {issue.title}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
        <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: stateColor, marginRight: 6 }}>
          <Text style={{ color: stateColor, fontSize: 11, fontWeight: '600' }}>{state}</Text>
        </View>
        {issue.user?.login ? (
          <Text style={{ color: colors.textDim, fontSize: 12 }}>{issue.user.login}</Text>
        ) : null}
      </View>
      {summary ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 1 }}>
          {prPills(summary, viewerId)}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// Render any Jira / GitHub references found in `body` as inline cards. If the
// viewer hasn't configured a given integration we just skip those refs — the
// URL is already a tappable link courtesy of <Markdown>.
export function MessageUnfurls({ body, viewerId }: { body: string; viewerId: string | null }) {
  const [jira, setJira] = useState<JiraIssue[]>([]);
  const [gh, setGh] = useState<GithubIssue[]>([]);

  useEffect(() => {
    if (!viewerId || !body) { setJira([]); setGh([]); return; }
    let active = true;
    const jiraRefs = extractJiraRefs(body);
    const ghRefs = extractGithubRefs(body);
    if (!jiraRefs.length && !ghRefs.length) { setJira([]); setGh([]); return; }
    (async () => {
      try {
        const jiraSettings = jiraRefs.length ? await getJiraSettings(viewerId) : null;
        const ghSettings = ghRefs.length ? await getGithubSettings(viewerId) : null;
        const jiraPs = jiraSettings ? jiraRefs.map((r) =>
          cachedFetch(jiraCache, jiraKey(viewerId, r.host, r.key), () => fetchJiraIssue(jiraSettings, r.key, r.host)),
        ) : [];
        const ghPs = ghSettings ? ghRefs.map((r) =>
          cachedFetch(ghCache, ghKey(viewerId, r.owner, r.repo, r.number), () => fetchGithubIssueOrPull(ghSettings, r.owner, r.repo, r.number)),
        ) : [];
        const [jiraRes, ghRes] = await Promise.all([Promise.all(jiraPs), Promise.all(ghPs)]);
        if (!active) return;
        setJira(jiraRes.filter((x): x is JiraIssue => !!x));
        setGh(ghRes.filter((x): x is GithubIssue => !!x));
      } catch (e: any) {
        // Belt + braces: the individual fetchers already swallow errors and
        // return null. Catching here covers anything we didn't anticipate
        // (e.g. an integrations.ts supabase fault on a stale session) so a
        // bad unfurl can't take down the whole message row. Log only the
        // message so the full error object — which on Supabase faults can
        // include the query context — never reaches crash reporters.
        console.warn('[unfurl] failed', e?.message ?? String(e));
      }
    })();
    return () => { active = false; };
  }, [body, viewerId]);

  if (!jira.length && !gh.length) return null;
  return (
    <View>
      {jira.map((i) => <JiraCard key={`j-${i.host}::${i.key}`} issue={i} />)}
      {gh.map((i) => <GitHubCard key={`g-${i.owner}/${i.repo}#${i.number}`} issue={i} viewerId={viewerId!} />)}
    </View>
  );
}

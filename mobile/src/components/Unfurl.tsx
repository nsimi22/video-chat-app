import React, { useEffect, useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { colors, radius, space } from '@/theme';
import { extractJiraRefs, fetchJiraIssue, jiraIssueUrl, type JiraIssue } from '@/lib/jira';
import { extractGithubRefs, fetchGithubIssueOrPull, type GithubIssue } from '@/lib/github';
import { getJiraSettings, getGithubSettings } from '@/lib/integrations';

// Tiny inline cards rendered below a chat body. The viewer uses *their own*
// credentials to fetch metadata (same model as desktop renderer/chat.js: each
// teammate sees only the tickets / repos their PAT or token can see).
//
// Fetches are deduped via a process-wide cache so a channel full of links to
// the same ticket only hits the API once.

type JiraCache = { [k: string]: Promise<JiraIssue | null> };
type GhCache = { [k: string]: Promise<GithubIssue | null> };
const jiraCache: JiraCache = {};
const ghCache: GhCache = {};

function jiraKey(host: string | undefined, key: string) { return `${host ?? '_'}::${key}`; }
function ghKey(owner: string, repo: string, number: string) { return `${owner}/${repo}#${number}`; }

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

function GitHubCard({ issue }: { issue: GithubIssue }) {
  const isPr = !!issue.pull_request;
  const state = ghStateLabel(issue);
  const stateColor = ghStateColor(issue.state, issue.pull_request?.merged_at ?? null);
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
      const jiraSettings = jiraRefs.length ? await getJiraSettings(viewerId) : null;
      const ghSettings = ghRefs.length ? await getGithubSettings(viewerId) : null;
      const jiraPs = jiraSettings ? jiraRefs.map((r) => {
        const k = jiraKey(r.host, r.key);
        if (!jiraCache[k]) jiraCache[k] = fetchJiraIssue(jiraSettings, r.key, r.host);
        return jiraCache[k];
      }) : [];
      const ghPs = ghSettings ? ghRefs.map((r) => {
        const k = ghKey(r.owner, r.repo, r.number);
        if (!ghCache[k]) ghCache[k] = fetchGithubIssueOrPull(ghSettings, r.owner, r.repo, r.number);
        return ghCache[k];
      }) : [];
      const [jiraRes, ghRes] = await Promise.all([Promise.all(jiraPs), Promise.all(ghPs)]);
      if (!active) return;
      setJira(jiraRes.filter((x): x is JiraIssue => !!x));
      setGh(ghRes.filter((x): x is GithubIssue => !!x));
    })();
    return () => { active = false; };
  }, [body, viewerId]);

  if (!jira.length && !gh.length) return null;
  return (
    <View>
      {jira.map((i) => <JiraCard key={`j-${i.host}::${i.key}`} issue={i} />)}
      {gh.map((i) => <GitHubCard key={`g-${i.owner}/${i.repo}#${i.number}`} issue={i} />)}
    </View>
  );
}

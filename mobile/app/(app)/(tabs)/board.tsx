import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  Bookmark,
  Bug,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronsDown,
  Equal,
  ChevronsUp,
  ExternalLink,
  SquareKanban,
  X,
  Zap,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { getTeamBoard } from '@/lib/api';
import { getJiraSettings } from '@/lib/integrations';
import {
  fetchJiraDescriptionBlocks,
  getJiraBoardConfig,
  jiraIsConfigured,
  jiraIssueUrl,
  listJiraAssignableUsers,
  listJiraPriorities,
  listJiraTransitions,
  searchJiraIssues,
  transitionJiraIssue,
  updateJiraIssue,
  type AdfBlock,
  type BoardColumnConfig,
  type JiraBoardIssue,
} from '@/lib/jira';
import type { JiraSettings } from '@/lib/integrations';
import { colors, radius, space, tabBarClearance } from '@/theme';

// Jira board tab — design prototype screen 6, read path of the desktop
// kanban (renderer/jira-board.js): the shared team_jira_board row names the
// project (falling back to the user's defaultProject), issues come from one
// JQL search, and columns mirror the project's real Agile-board config when
// visible (deriving from live statuses otherwise). Mobile is read +
// column-switch + card detail; drag-and-drop stays desktop-only by design.

type Ticket = {
  key: string;
  type: string;
  summary: string;
  priority: string;
  assignee: string | null;
  assigneeId: string | null;
  status: string;
  cat: string;
  labels: string[];
};

type Column = { id: string; name: string; statuses: string[]; cat: string };

const CAT_ORDER: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };

function mapIssue(issue: JiraBoardIssue): Ticket {
  const f = issue.fields ?? {};
  return {
    key: issue.key,
    type: f.issuetype?.name || 'Task',
    summary: f.summary || '(no summary)',
    priority: f.priority?.name || 'Medium',
    assignee: f.assignee?.displayName ?? null,
    assigneeId: f.assignee?.accountId ?? null,
    status: f.status?.name || 'To Do',
    cat: f.status?.statusCategory?.key || 'new',
    labels: Array.isArray(f.labels) ? f.labels : [],
  };
}

function statusAccent(cat: string, name: string): string {
  const c = (cat || '').toLowerCase();
  if (c === 'done') return colors.online;
  if (c === 'new' || c === 'to do') return colors.textFaint;
  if (/review|qa|test|verify/i.test(name || '')) return colors.live;
  return colors.away; // indeterminate / in progress
}

// Mirrors desktop deriveColumns(): board config when available (Jira's
// columns, in Jira's order, including empty ones), with uncovered statuses
// appended; otherwise one column per status in play, category-ordered.
function deriveColumns(tickets: Ticket[], boardCols: BoardColumnConfig[] | null): Column[] {
  if (boardCols && boardCols.length) {
    const cols: Column[] = boardCols.map((c, i) => ({
      id: `${i}:${c.name}`,
      name: c.name,
      statuses: c.statuses.map((s) => s.name),
      cat: c.statuses[c.statuses.length - 1]?.cat || 'new',
    }));
    const covered = new Set(cols.flatMap((c) => c.statuses.map((s) => s.toLowerCase())));
    const extras: Column[] = [];
    for (const t of tickets) {
      if (covered.has(t.status.toLowerCase())) continue;
      covered.add(t.status.toLowerCase());
      extras.push({ id: t.status, name: t.status, statuses: [t.status], cat: t.cat });
    }
    extras.sort((a, b) => (CAT_ORDER[a.cat] ?? 1) - (CAT_ORDER[b.cat] ?? 1));
    return [...cols, ...extras];
  }
  const seen = new Map<string, Column>();
  for (const t of tickets) {
    if (!seen.has(t.status)) seen.set(t.status, { id: t.status, name: t.status, statuses: [t.status], cat: t.cat });
  }
  const cols = [...seen.values()];
  cols.sort((a, b) => (CAT_ORDER[a.cat] ?? 1) - (CAT_ORDER[b.cat] ?? 1));
  if (!cols.length) {
    return [
      { id: 'To Do', name: 'To Do', statuses: ['To Do'], cat: 'new' },
      { id: 'In Progress', name: 'In Progress', statuses: ['In Progress'], cat: 'indeterminate' },
      { id: 'Done', name: 'Done', statuses: ['Done'], cat: 'done' },
    ];
  }
  return cols;
}

function typeMeta(type: string): { icon: LucideIcon; color: string } {
  const t = (type || '').toLowerCase();
  if (t === 'bug') return { icon: Bug, color: colors.busy };
  if (t === 'story') return { icon: Bookmark, color: colors.online };
  if (t === 'epic') return { icon: Zap, color: colors.accentTx };
  return { icon: CheckSquare, color: colors.accent };
}

function prioMeta(p: string): { icon: LucideIcon; color: string } {
  const v = (p || '').toLowerCase();
  if (v === 'highest' || v === 'high') return { icon: ChevronsUp, color: colors.busy };
  if (v === 'low' || v === 'lowest') return { icon: ChevronsDown, color: colors.live };
  return { icon: Equal, color: colors.away };
}

export default function BoardScreen() {
  const insets = useSafeAreaInsets();
  const { activeTeam, userId } = useAuth();
  const [jira, setJira] = useState<JiraSettings | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [boardName, setBoardName] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [activeCol, setActiveCol] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openTicket, setOpenTicket] = useState<Ticket | null>(null);
  // Last successful load — a full board load is up to ~9 Jira/Supabase
  // round-trips, so incidental tab focuses within the TTL are free.
  // Pull-to-refresh always bypasses.
  const lastLoadedAt = useRef(0);
  const BOARD_TTL_MS = 60_000;

  const load = useCallback(async ({ pull = false }: { pull?: boolean } = {}) => {
    if (!activeTeam || !userId) return;
    if (!pull && Date.now() - lastLoadedAt.current < BOARD_TTL_MS) return;
    if (pull) setRefreshing(true);
    try {
      const [settings, teamBoard] = await Promise.all([
        getJiraSettings(userId),
        getTeamBoard(activeTeam.id).catch(() => null),
      ]);
      setJira(settings);
      // Shared team selection wins; per-user defaultProject is the fallback
      // (same precedence as desktop's activeProject()).
      const proj = (teamBoard?.project_key || settings?.defaultProject || '').toUpperCase() || null;
      setProject(proj);
      setBoardName(teamBoard?.board_name ?? null);
      if (!settings || !jiraIsConfigured(settings) || !proj) {
        setTickets([]);
        setColumns([]);
        setError(null);
        return;
      }
      // Active work plus a recent-Done window (mirrors how Jira boards
      // hide stale done issues) — keeps the result set bounded so the
      // pagination cap can't push live statuses off the board again.
      const jql = `project = "${proj}" AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC`;
      const [issues, boardCols] = await Promise.all([
        searchJiraIssues(settings, jql, 500),
        getJiraBoardConfig(settings, proj),
      ]);
      const mapped = issues.map(mapIssue);
      const cols = deriveColumns(mapped, boardCols);
      setTickets(mapped);
      setColumns(cols);
      setError(null);
      lastLoadedAt.current = Date.now();
      setActiveCol((curr) => (curr && cols.some((c) => c.id === curr) ? curr : cols.find((c) => c.cat === 'indeterminate')?.id ?? cols[0]?.id ?? null));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
      if (pull) setRefreshing(false);
    }
  }, [activeTeam, userId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const col = columns.find((c) => c.id === activeCol) ?? null;
  const colStatusSet = useMemo(() => new Set((col?.statuses ?? []).map((s) => s.toLowerCase())), [col]);
  const cards = useMemo(() => tickets.filter((t) => colStatusSet.has(t.status.toLowerCase())), [tickets, colStatusSet]);
  const countFor = useCallback(
    (c: Column) => {
      const set = new Set(c.statuses.map((s) => s.toLowerCase()));
      return tickets.filter((t) => set.has(t.status.toLowerCase())).length;
    },
    [tickets],
  );

  const configured = jira && jiraIsConfigured(jira);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header — large title + project key chip */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.25), paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(2) }}>
        <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: colors.text }}>Board</Text>
        {project && (
          <Text style={{ fontSize: 11.5, color: colors.textFaint, backgroundColor: colors.surfaceAlt, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden', fontVariant: ['tabular-nums'] }}>
            {project}
          </Text>
        )}
      </View>
      {boardName && (
        <View style={{ paddingHorizontal: space(4), paddingBottom: space(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space(2.75), paddingVertical: space(1.75) }}>
            <SquareKanban size={15} color={colors.accentTx} />
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{boardName}</Text>
          </View>
        </View>
      )}

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : !configured ? (
        <BoardEmpty title="Connect Jira to see your board" sub="Add your Atlassian credentials in the desktop app's Settings panel — mobile reads the same account." />
      ) : !project ? (
        <BoardEmpty title="No board picked yet" sub="Pick a project for the team board on desktop (or set a default project in Jira settings)." />
      ) : error ? (
        <BoardEmpty title="Couldn't load the board" sub={error} />
      ) : (
        <>
          {/* Column chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(2.5), gap: 7 }}>
            {columns.map((c) => {
              const on = c.id === activeCol;
              const accent = statusAccent(c.cat, c.name);
              return (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => setActiveCol(c.id)}
                  activeOpacity={0.75}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 7,
                    height: 30,
                    paddingHorizontal: space(3),
                    borderRadius: 15,
                    backgroundColor: on ? colors.accent : colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: on ? 'transparent' : colors.borderSoft,
                  }}
                >
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: on ? colors.bg : accent }} />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: on ? colors.bg : colors.textMid }}>{c.name}</Text>
                  <Text style={{ fontSize: 11.5, color: on ? colors.bg : colors.textDim, opacity: 0.8, fontVariant: ['tabular-nums'] }}>{countFor(c)}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Cards */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: tabBarClearance(insets.bottom), gap: 9 }}
            refreshControl={<RefreshControl tintColor={colors.accent} refreshing={refreshing} onRefresh={() => load({ pull: true })} />}
          >
            {cards.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13, paddingVertical: space(4) }}>Nothing in {col?.name ?? 'this column'}.</Text>
            )}
            {cards.map((t) => {
              const tm = typeMeta(t.type);
              const pm = prioMeta(t.priority);
              const accent = statusAccent(t.cat, t.status);
              return (
                <TouchableOpacity
                  key={t.key}
                  onPress={() => setOpenTicket(t)}
                  activeOpacity={0.75}
                  style={{
                    backgroundColor: colors.surfaceAlt,
                    borderWidth: 1,
                    borderColor: colors.borderSoft,
                    borderLeftWidth: 3,
                    borderLeftColor: accent,
                    borderRadius: radius.md,
                    padding: space(3.25),
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginBottom: space(2) }}>
                    <View style={{ width: 18, height: 18, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised }}>
                      <tm.icon size={12} color={tm.color} />
                    </View>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: colors.textDim, fontVariant: ['tabular-nums'] }}>{t.key}</Text>
                    <View style={{ flex: 1 }} />
                    <pm.icon size={15} color={pm.color} strokeWidth={2.4} />
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.text, lineHeight: 19.5, marginBottom: space(2.5) }}>{t.summary}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap', flex: 1 }}>
                      {t.labels.map((l) => (
                        <Text
                          key={l}
                          style={{
                            fontSize: 10.5,
                            fontWeight: '600',
                            color: l === 'bug' ? colors.busy : colors.textMid,
                            backgroundColor: colors.raised,
                            borderRadius: 5,
                            paddingHorizontal: 7,
                            paddingVertical: 2,
                            overflow: 'hidden',
                          }}
                        >
                          {l}
                        </Text>
                      ))}
                    </View>
                    {t.assignee && (
                      <Text style={{ fontSize: 11.5, color: colors.textDim }} numberOfLines={1}>
                        {t.assignee.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </>
      )}

      <CardSheet
        ticket={openTicket}
        jira={jira}
        project={project}
        onClose={() => setOpenTicket(null)}
        onUpdated={(patched) => {
          // Patch the board list in place; a status change naturally moves
          // the card to its new column since cards filter by status.
          setTickets((prev) => prev.map((x) => (x.key === patched.key ? patched : x)));
          setOpenTicket(patched);
        }}
      />
    </SafeAreaView>
  );
}

function BoardEmpty({ title, sub }: { title: string; sub: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8) }}>
      <View style={{ width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, marginBottom: space(3) }}>
        <SquareKanban size={24} color={colors.textFaint} />
      </View>
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', marginBottom: 4, textAlign: 'center' }}>{title}</Text>
      <Text style={{ color: colors.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>{sub}</Text>
    </View>
  );
}

// Card detail bottom sheet — design prototype's CardSheet with desktop
// parity on edits: Status (workflow transitions), Assignee (assignable
// users), and Priority are tappable and write back to Jira, mirroring
// renderer/jira-board.js. Description renders ADF blocks so headings are
// called out instead of flattening into one run of text.
type PickerKind = 'status' | 'assignee' | 'priority';
// `cat` carries the target status's real category (statusCategory.key from
// the /transitions response) so applyPick doesn't have to guess it.
type PickerOption = { id: string; label: string; selected: boolean; cat?: string };

function CardSheet({
  ticket,
  jira,
  project,
  onClose,
  onUpdated,
}: {
  ticket: Ticket | null;
  jira: JiraSettings | null;
  project: string | null;
  onClose: () => void;
  onUpdated: (t: Ticket) => void;
}) {
  const [blocks, setBlocks] = useState<AdfBlock[] | null>(null);
  const [descLoading, setDescLoading] = useState(false);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [options, setOptions] = useState<PickerOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const t = ticket;
  const editable = !!(jira && jiraIsConfigured(jira));

  useEffect(() => {
    setBlocks(null);
    setPicker(null);
    if (!t || !jira || !jiraIsConfigured(jira)) return;
    let cancelled = false;
    setDescLoading(true);
    fetchJiraDescriptionBlocks(jira, t.key)
      .then((b) => { if (!cancelled) setBlocks(b); })
      .finally(() => { if (!cancelled) setDescLoading(false); });
    return () => { cancelled = true; };
  }, [t?.key, jira]);

  if (!t) return null;
  const tm = typeMeta(t.type);
  const pm = prioMeta(t.priority);
  const accent = statusAccent(t.cat, t.status);

  // Open a picker: fetch its option set fresh (transitions are per-issue;
  // users/priorities are cheap and a stale cache would be worse).
  const openPicker = async (kind: PickerKind) => {
    if (!editable || !jira) return;
    setPicker(kind);
    setOptions(null);
    try {
      if (kind === 'status') {
        const transitions = await listJiraTransitions(jira, t.key);
        setOptions(transitions.map((tr) => ({
          id: tr.id,
          label: tr.to?.name || tr.name,
          selected: (tr.to?.name || '').toLowerCase() === t.status.toLowerCase(),
          cat: tr.to?.statusCategory?.key,
        })));
      } else if (kind === 'assignee') {
        const users = await listJiraAssignableUsers(jira, project || '');
        setOptions([
          { id: '', label: 'Unassigned', selected: !t.assigneeId },
          ...users.map((u) => ({ id: u.accountId, label: u.displayName, selected: u.accountId === t.assigneeId })),
        ]);
      } else {
        const priorities = await listJiraPriorities(jira);
        setOptions(priorities.map((p) => ({ id: p.name, label: p.name, selected: p.name === t.priority })));
      }
    } catch (e: any) {
      setPicker(null);
      Alert.alert('Could not load options', e?.message ?? String(e));
    }
  };

  const applyPick = async (opt: PickerOption) => {
    if (!jira || busy) return;
    setBusy(true);
    try {
      if (picker === 'status') {
        await transitionJiraIssue(jira, t.key, opt.id);
        // Use the real statusCategory from the transitions response; the
        // name-regex is only a fallback for a response that omits it.
        const name = opt.label;
        const cat = opt.cat
          || (/done|closed|resolved/i.test(name) ? 'done' : /to do|backlog|open|scoping/i.test(name) ? 'new' : 'indeterminate');
        onUpdated({ ...t, status: name, cat });
      } else if (picker === 'assignee') {
        await updateJiraIssue(jira, t.key, { assigneeAccountId: opt.id || null });
        onUpdated({ ...t, assignee: opt.id ? opt.label : null, assigneeId: opt.id || null });
      } else if (picker === 'priority') {
        await updateJiraIssue(jira, t.key, { priorityName: opt.id });
        onUpdated({ ...t, priority: opt.id });
      }
      setPicker(null);
    } catch (e: any) {
      Alert.alert('Update failed', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const Field = ({ label, kind, children }: { label: string; kind?: PickerKind; children: React.ReactNode }) => {
    const body = (
      <>
        <Text style={{ width: 84, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: colors.textFaint }}>{label}</Text>
        <View style={{ flex: 1 }}>{children}</View>
        {kind && editable && <ChevronDown size={15} color={colors.textFaint} />}
      </>
    );
    const rowStyle = {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: space(2.5),
      paddingVertical: space(3),
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSoft,
    };
    if (kind && editable) {
      return (
        <TouchableOpacity onPress={() => openPicker(kind)} activeOpacity={0.7} style={rowStyle} accessibilityLabel={`Change ${label.toLowerCase()}`}>
          {body}
        </TouchableOpacity>
      );
    }
    return <View style={rowStyle}>{body}</View>;
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} onPress={onClose} />
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderTopColor: colors.border, maxHeight: '88%' }}>
          <SafeAreaView edges={['bottom']} style={{ paddingBottom: space(3) }}>
            <View style={{ alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: colors.border, marginTop: space(2) }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.borderSoft }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised }}>
                <tm.icon size={14} color={tm.color} />
              </View>
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: colors.textMid, fontVariant: ['tabular-nums'] }}>{t.key}</Text>
              <View style={{ flex: 1 }} />
              {editable && jira && (
                <TouchableOpacity
                  onPress={() => Linking.openURL(jiraIssueUrl(jira.host!, t.key)).catch(() => {})}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: space(2.5), paddingVertical: space(1.25) }}
                >
                  <ExternalLink size={13} color={colors.accentTx} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: colors.accentTx }}>Jira</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <X size={20} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: space(4), paddingTop: space(3.5), paddingBottom: space(6) }}>
              <Text style={{ fontSize: 18, fontWeight: '700', lineHeight: 24, color: colors.text, marginBottom: space(3.5) }}>{t.summary}</Text>
              <Field label="Status" kind="status">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: colors.raised, borderRadius: 6, paddingHorizontal: space(2.5), paddingVertical: 3 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: accent }} />
                  <Text style={{ fontSize: 11.5, fontWeight: '700', color: accent }}>{t.status}</Text>
                </View>
              </Field>
              <Field label="Assignee" kind="assignee">
                <Text style={{ fontSize: 13.5, fontWeight: '600', color: t.assignee ? colors.text : colors.textDim }}>{t.assignee ?? 'Unassigned'}</Text>
              </Field>
              <Field label="Priority" kind="priority">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <pm.icon size={16} color={pm.color} strokeWidth={2.4} />
                  <Text style={{ fontSize: 13.5, fontWeight: '600', color: colors.text }}>{t.priority}</Text>
                </View>
              </Field>
              {t.labels.length > 0 && (
                <Field label="Labels">
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    {t.labels.map((l) => (
                      <Text key={l} style={{ fontSize: 10.5, fontWeight: '600', color: l === 'bug' ? colors.busy : colors.textMid, backgroundColor: colors.raised, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' }}>
                        {l}
                      </Text>
                    ))}
                  </View>
                </Field>
              )}
              <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: colors.textFaint, marginTop: space(4), marginBottom: space(2.5) }}>
                Description
              </Text>
              {descLoading ? (
                <ActivityIndicator color={colors.accent} style={{ alignSelf: 'flex-start' }} />
              ) : blocks?.length ? (
                <DescriptionBlocks blocks={blocks} />
              ) : (
                <Text style={{ fontSize: 14, lineHeight: 22, color: colors.textMid }}>No description.</Text>
              )}
            </ScrollView>

          </SafeAreaView>
        </View>

        {/* Inline picker overlay — rendered at the Modal root (a nested
            Modal would fight iOS's one-modal-at-a-time rule) so it can be
            taller than the card sheet and never clips at the screen edge. */}
        {picker && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}>
            <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={() => !busy && setPicker(null)} />
            <View style={{ backgroundColor: colors.surfaceAlt, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1, borderTopColor: colors.border, maxHeight: '70%' }}>
              <SafeAreaView edges={['bottom']} style={{ paddingBottom: space(3) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingTop: space(3.5), paddingBottom: space(2) }}>
                  <Text style={{ flex: 1, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textFaint }}>
                    {picker === 'status' ? 'Move to' : picker === 'assignee' ? 'Assign to' : 'Set priority'}
                  </Text>
                  <TouchableOpacity onPress={() => !busy && setPicker(null)} hitSlop={8}>
                    <X size={18} color={colors.textDim} />
                  </TouchableOpacity>
                </View>
                {!options ? (
                  <ActivityIndicator color={colors.accent} style={{ paddingVertical: space(5) }} />
                ) : (
                  <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: space(4) }}>
                    {options.map((opt) => (
                      <TouchableOpacity
                        key={opt.id || 'none'}
                        disabled={busy}
                        onPress={() => applyPick(opt)}
                        activeOpacity={0.7}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(4), paddingVertical: space(3), opacity: busy ? 0.5 : 1 }}
                      >
                        <Text style={{ flex: 1, fontSize: 15, fontWeight: opt.selected ? '700' : '500', color: opt.selected ? colors.accentTx : colors.text }}>
                          {opt.label}
                        </Text>
                        {opt.selected && <Check size={17} color={colors.accentTx} />}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
              </SafeAreaView>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ADF block renderer — headings called out, paragraphs spaced, list items
// bulleted/numbered, code in a mono panel.
function DescriptionBlocks({ blocks }: { blocks: AdfBlock[] }) {
  return (
    <View style={{ gap: space(2) }}>
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const big = b.level <= 2;
          return (
            <Text
              key={i}
              style={{
                fontSize: big ? 15.5 : 14,
                fontWeight: '700',
                color: colors.text,
                marginTop: i === 0 ? 0 : space(2.5),
                letterSpacing: -0.2,
              }}
            >
              {b.text}
            </Text>
          );
        }
        if (b.type === 'li') {
          return (
            <View key={i} style={{ flexDirection: 'row', gap: space(2), paddingLeft: space(2) + b.depth * space(4) }}>
              <Text style={{ fontSize: 14, lineHeight: 22, color: colors.textFaint, minWidth: 14 }}>
                {b.ordered ? `${b.index}.` : '•'}
              </Text>
              <Text style={{ flex: 1, fontSize: 14, lineHeight: 22, color: colors.textMid }}>{b.text}</Text>
            </View>
          );
        }
        if (b.type === 'code') {
          return (
            <Text
              key={i}
              style={{
                fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
                fontSize: 12.5,
                lineHeight: 19,
                color: colors.textMid,
                backgroundColor: colors.bg,
                borderWidth: 1,
                borderColor: colors.borderSoft,
                borderRadius: radius.sm,
                padding: space(3),
              }}
            >
              {b.text}
            </Text>
          );
        }
        if (b.type === 'quote') {
          return (
            <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space(2.5) }}>
              <Text style={{ fontSize: 14, lineHeight: 22, color: colors.textDim }}>{b.text}</Text>
            </View>
          );
        }
        return (
          <Text key={i} style={{ fontSize: 14, lineHeight: 22, color: colors.textMid }}>{b.text}</Text>
        );
      })}
    </View>
  );
}

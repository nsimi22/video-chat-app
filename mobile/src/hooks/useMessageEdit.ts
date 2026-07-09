import { useCallback, useEffect, useState } from 'react';
import { Alert, type TextInput } from 'react-native';
import { editMessage, type Message } from '@/lib/api';

// Shared in-place message-edit state machine for the channel and thread
// composers. Both screens own identical `text` / `sending` state and an
// `inputRef`; this hook layers the editing lifecycle on top so the two don't
// drift. Edits are text-only (no attachments / slash dispatch) and update the
// existing row via editMessage() rather than posting a new message.
//
// `messages` is the currently-visible list so the hook can drop out of edit
// mode if the message being edited is deleted (locally or over realtime) —
// otherwise Save would fire editMessage() at a row that no longer exists.
export function useMessageEdit(opts: {
  messages: Message[];
  text: string;
  setText: (t: string) => void;
  setSending: (b: boolean) => void;
  inputRef: React.RefObject<TextInput | null>;
}) {
  const { messages, text, setText, setSending, inputRef } = opts;
  const [editing, setEditing] = useState<Message | null>(null);

  // Enter edit mode: prime the composer with the message body and focus it.
  const startEditing = useCallback((m: Message) => {
    setEditing(m);
    setText(m.body ?? '');
    // Defer focus a tick so the value is set before the keyboard opens.
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [setText, inputRef]);

  const cancelEditing = useCallback(() => {
    setEditing(null);
    setText('');
  }, [setText]);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const body = text.trim();
    if (!body) {
      Alert.alert('Empty message', 'An edited message can’t be empty. Delete it instead to remove it.');
      return;
    }
    // Compare against the message's *current* body, not the snapshot captured
    // when editing began — if it changed underneath us (realtime UPDATE from
    // another client) an unchanged composer is a real edit back to our text,
    // not a no-op we should silently discard.
    const current = messages.find((m) => m.id === editing.id) ?? editing;
    if (body === (current.body ?? '').trim()) {
      cancelEditing();
      return;
    }
    setSending(true);
    try {
      await editMessage(editing.id, body);
      cancelEditing();
    } catch (e: any) {
      Alert.alert('Could not save edit', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }, [editing, text, messages, setSending, cancelEditing]);

  // Exit edit mode if the target message disappears from the list.
  useEffect(() => {
    if (editing && !messages.some((m) => m.id === editing.id)) cancelEditing();
  }, [editing, messages, cancelEditing]);

  return { editing, startEditing, cancelEditing, saveEdit };
}

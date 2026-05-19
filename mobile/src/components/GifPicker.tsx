import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { searchGifs, type GiphyResult } from '@/lib/giphy';
import { colors, radius, space } from '@/theme';

type Props = {
  visible: boolean;
  apiKey: string | null;
  onClose: () => void;
  onSelect: (gif: GiphyResult) => void;
};

// Two-column grid. The picker fetches trending on open and re-fetches on
// every (debounced) keystroke. Stale-response guard via an in-flight seq —
// a faster query bumping the seq drops earlier responses on the floor.
export function GifPicker({ visible, apiKey, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GiphyResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Memoized so the effect below can list it as a dep without re-binding on
  // every render. `seqRef` is a stable ref, so apiKey is the only real
  // input — bumping the seq lets late responses (for a stale apiKey/query)
  // get dropped on the floor.
  const fetchNow = useCallback(async (q: string) => {
    if (!apiKey) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await searchGifs(apiKey, q.trim());
      if (seq !== seqRef.current) return;
      setResults(data);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(`Could not reach Giphy: ${(e as Error)?.message ?? String(e)}`);
      setResults([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults([]);
      setError(null);
      return;
    }
    if (!apiKey) {
      setError('No Giphy API key configured. Open Settings (⚙) on desktop → Giphy.');
      return;
    }
    void fetchNow('');
    // Clear any pending debounced search if the picker closes / apiKey
    // changes / the component unmounts mid-debounce — prevents a setState
    // after unmount.
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Bump the seq so any in-flight fetch sees a stale id and returns
      // before touching state.
      seqRef.current += 1;
    };
  }, [visible, apiKey, fetchNow]);

  const onChangeQuery = (t: string) => {
    setQuery(t);
    if (!apiKey) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchNow(t), 250);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      // pageSheet on iOS: stops below the status bar with rounded top
      // corners, and gives you drag-down-to-dismiss without writing it.
      // Falls back to fullScreen on Android.
      presentationStyle="pageSheet"
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: space(3),
            paddingVertical: space(2),
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            gap: space(2),
          }}
        >
          <TextInput
            value={query}
            onChangeText={onChangeQuery}
            placeholder="Search GIPHY…"
            placeholderTextColor={colors.textDim}
            autoFocus
            style={{
              flex: 1,
              color: colors.text,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.md,
              paddingHorizontal: space(3),
              paddingVertical: space(2),
              fontSize: 15,
            }}
          />
          <TouchableOpacity onPress={onClose} hitSlop={8} style={{ padding: space(2) }}>
            <X size={22} color={colors.textDim} />
          </TouchableOpacity>
        </View>

        {/* Body */}
        {error ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6) }}>
            <Text style={{ color: colors.textDim, textAlign: 'center' }}>{error}</Text>
          </View>
        ) : loading && results.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <FlatList
            data={results}
            numColumns={2}
            keyExtractor={(g) => g.id}
            contentContainerStyle={{ padding: space(1) }}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => onSelect(item)}
                activeOpacity={0.75}
                style={{
                  flex: 1,
                  aspectRatio: 1,
                  margin: space(1),
                  borderRadius: radius.sm,
                  overflow: 'hidden',
                  backgroundColor: colors.surfaceAlt,
                }}
              >
                <Image source={{ uri: item.preview }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={{ padding: space(8), alignItems: 'center' }}>
                <Text style={{ color: colors.textDim }}>No matches.</Text>
              </View>
            }
          />
        )}

        {/* Attribution — required by Giphy API ToS */}
        <View style={{ paddingVertical: space(2), alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border }}>
          <Text style={{ color: colors.textDim, fontSize: 11 }}>Powered by GIPHY</Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

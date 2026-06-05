import { useState } from 'react';
import { Modal, Pressable, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BarChart3, Plus, X } from 'lucide-react-native';
import { colors, radius, space } from '@/theme';

const MAX_OPTIONS = 10; // matches desktop's POLL_MAX_OPTIONS

// Bottom-sheet poll composer — design prototype's CreatePollSheet, plus the
// multi-answer toggle the desktop composer has (the prototype omitted it
// but the backend and desktop both support `multi`).
export function CreatePollSheet({
  visible,
  onClose,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], multi: boolean) => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && filled.length >= 2;

  const reset = () => {
    setQuestion('');
    setOptions(['', '']);
    setMulti(false);
  };

  const setOpt = (i: number, v: string) => setOptions((a) => a.map((x, j) => (j === i ? v : x)));

  const inputStyle = {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space(3),
    paddingVertical: space(2.75),
    color: colors.text,
    fontSize: 15,
  } as const;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} onPress={onClose} />
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderTopColor: colors.border, maxHeight: '88%' }}>
          <SafeAreaView edges={['bottom']} style={{ paddingBottom: space(3) }}>
            <View style={{ alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: colors.border, marginTop: space(2), marginBottom: space(0.5) }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2.25), paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: colors.borderSoft }}>
              <View style={{ width: 26, height: 26, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentDim }}>
                <BarChart3 size={16} color={colors.accentTx} />
              </View>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }}>New poll</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <X size={20} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: space(4) }} keyboardShouldPersistTaps="handled">
              <Text style={{ fontSize: 11.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textFaint, marginBottom: space(1.75) }}>
                Question
              </Text>
              <TextInput
                value={question}
                onChangeText={setQuestion}
                placeholder="Ask something…"
                placeholderTextColor={colors.textFaint}
                style={[inputStyle, { borderColor: question.trim() ? colors.accent : colors.border }]}
              />
              <Text style={{ fontSize: 11.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textFaint, marginTop: space(4), marginBottom: space(1.75) }}>
                Options
              </Text>
              <View style={{ gap: space(2) }}>
                {options.map((o, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
                    <Text style={{ width: 16, fontSize: 12, color: colors.textFaint, fontVariant: ['tabular-nums'] }}>{i + 1}</Text>
                    <TextInput
                      value={o}
                      onChangeText={(v) => setOpt(i, v)}
                      placeholder={`Option ${i + 1}`}
                      placeholderTextColor={colors.textFaint}
                      maxLength={150}
                      style={[inputStyle, { flex: 1 }]}
                    />
                    {options.length > 2 && (
                      <TouchableOpacity onPress={() => setOptions((a) => a.filter((_, j) => j !== i))} hitSlop={8}>
                        <X size={17} color={colors.textFaint} />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </View>
              {options.length < MAX_OPTIONS && (
                <TouchableOpacity
                  onPress={() => setOptions((a) => [...a, ''])}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space(2.75), alignSelf: 'flex-start' }}
                  hitSlop={6}
                >
                  <Plus size={16} color={colors.accentTx} strokeWidth={2.4} />
                  <Text style={{ color: colors.accentTx, fontSize: 13.5, fontWeight: '600' }}>Add option</Text>
                </TouchableOpacity>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space(4) }}>
                <Text style={{ color: colors.textMid, fontSize: 14 }}>Allow multiple answers</Text>
                <Switch
                  value={multi}
                  onValueChange={setMulti}
                  trackColor={{ false: colors.raised, true: colors.accent }}
                  thumbColor="#fff"
                />
              </View>
              <TouchableOpacity
                disabled={!valid}
                onPress={() => {
                  onCreate(question.trim(), filled, multi);
                  reset();
                }}
                activeOpacity={0.8}
                style={{
                  marginTop: space(5),
                  height: 48,
                  borderRadius: radius.md,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: space(2),
                  backgroundColor: valid ? colors.accent : colors.surfaceAlt,
                }}
              >
                <BarChart3 size={18} color={valid ? colors.bg : colors.textDim} />
                <Text style={{ fontSize: 15.5, fontWeight: '700', color: valid ? colors.bg : colors.textDim }}>Create poll</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  );
}

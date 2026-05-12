import React from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  View,
  StyleSheet,
  ActivityIndicator,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, space } from '@/theme';

export function Screen({ children, padded = true }: { children: React.ReactNode; padded?: boolean }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom']}>
      <View style={{ flex: 1, padding: padded ? space(4) : 0 }}>{children}</View>
    </SafeAreaView>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}
export function P({ children }: { children: React.ReactNode }) {
  return <Text style={styles.p}>{children}</Text>;
}

export function Field(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.textDim}
      {...props}
      style={[styles.field, props.style]}
    />
  );
}

export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const bg =
    variant === 'primary' ? colors.accent : variant === 'danger' ? colors.danger : 'transparent';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.5 : 1, borderWidth: variant === 'ghost' ? 1 : 0, borderColor: colors.border },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'ghost' ? colors.text : '#fff'} />
      ) : (
        <Text style={[styles.btnText, { color: variant === 'ghost' ? colors.text : '#fff' }]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

export function Avatar({ name, color, size = 36, uri }: { name: string; color?: string | null; size?: number; uri?: string | null }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color || colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: size * 0.4 }}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  h1: { color: colors.text, fontSize: 26, fontWeight: '700', marginBottom: space(2) },
  p: { color: colors.textDim, fontSize: 15, marginBottom: space(4), lineHeight: 21 },
  field: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
    marginBottom: space(3),
  },
  btn: {
    borderRadius: radius.md,
    paddingVertical: space(3.5),
    alignItems: 'center',
    marginTop: space(2),
  },
  btnText: { fontSize: 16, fontWeight: '600' },
});

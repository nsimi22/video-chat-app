import React from 'react';
import {
  Linking,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
  StyleSheet,
  ActivityIndicator,
  type TextInputProps,
  type TextStyle,
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

// Brand mark: three overlapping iOS-blue circles — same geometry as the
// desktop login hero (renderer/index.html: viewBox 56, r=11, centers
// (20,22), (36,22), (28,36)). Pure-RN so no extra SVG dep; solid fills
// instead of the desktop's cyan→blue gradient, which keeps the bundle lean.
export function Logo({ size = 56 }: { size?: number }) {
  const s = size / 56;
  const r = 11 * s;
  const circle = (cx: number, cy: number, opacity = 1) => ({
    position: 'absolute' as const,
    left: cx * s - r,
    top: cy * s - r,
    width: r * 2,
    height: r * 2,
    borderRadius: r,
    backgroundColor: colors.accent,
    opacity,
  });
  return (
    <View style={{ width: size, height: size }}>
      <View style={circle(20, 22, 0.85)} />
      <View style={circle(36, 22, 0.85)} />
      <View style={circle(28, 36, 1)} />
    </View>
  );
}

export function Brand({ tagline }: { tagline?: string }) {
  return (
    <View style={{ alignItems: 'center', marginBottom: space(6) }}>
      <Logo size={56} />
      <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: space(2) }}>
        Huddle
      </Text>
      {tagline ? (
        <Text style={{ color: colors.textDim, fontSize: 14, marginTop: space(1), textAlign: 'center' }}>
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}

// Quiet inline text button — e.g. "Use a password instead" / "Use the
// email code instead". Visually subtle (no background) so it doesn't
// compete with the primary Button on the same screen.
export function LinkButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={{ alignSelf: 'center', paddingVertical: space(3) }}>
      <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '500', opacity: disabled ? 0.5 : 1 }}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

export function Avatar({ name, color, size = 36, uri, ai }: { name: string; color?: string | null; size?: number; uri?: string | null; ai?: boolean }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  const box = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: ai ? colors.accent : (color || colors.surfaceAlt),
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  };
  if (uri && !ai) {
    return <Image source={{ uri }} style={box} />;
  }
  return (
    <View style={box}>
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: size * (ai ? 0.5 : 0.4) }}>
        {ai ? '🤖' : initials}
      </Text>
    </View>
  );
}

// Tiny markdown renderer for chat bodies — mirrors renderer/markdown.js:
// **bold**, *italic*, `inline code`, blockquote (lines starting with `> `),
// and autolinked http(s) URLs. Pure regex; no markdown library.
const INLINE_RE = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(https?:\/\/[^\s<>'"]+)/g;
function renderInline(text: string, prefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  // RegExp with /g is stateful, so reset before each call.
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(<Text key={`${prefix}t${i++}`}>{text.slice(last, m.index)}</Text>);
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<Text key={`${prefix}b${i++}`} style={{ fontWeight: '700' }}>{tok.slice(2, -2)}</Text>);
    } else if (tok.startsWith('*')) {
      out.push(<Text key={`${prefix}i${i++}`} style={{ fontStyle: 'italic' }}>{tok.slice(1, -1)}</Text>);
    } else if (tok.startsWith('`')) {
      out.push(
        <Text key={`${prefix}c${i++}`} style={{ fontFamily: 'Menlo', backgroundColor: colors.surfaceAlt }}>
          {' '}{tok.slice(1, -1)}{' '}
        </Text>,
      );
    } else {
      const url = tok;
      out.push(
        <Text
          key={`${prefix}u${i++}`}
          style={{ color: colors.accent, textDecorationLine: 'underline' }}
          onPress={() => Linking.openURL(url).catch(() => {})}
        >
          {url}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Text key={`${prefix}t${i++}`}>{text.slice(last)}</Text>);
  return out;
}

export function Markdown({ body, baseStyle }: { body: string; baseStyle?: TextStyle }) {
  // Block-level: contiguous `> ` lines render as a quoted block (left border
  // + dim text); everything else is a paragraph. Paragraphs keep newlines so
  // multi-line bodies don't run together.
  const blocks: React.ReactNode[] = [];
  let buf: string[] = [];
  let kind: 'p' | 'q' = 'p';
  let bi = 0;
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n');
    if (kind === 'q') {
      blocks.push(
        <View key={`q${bi}`} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space(2), marginVertical: 2 }}>
          <Text style={[{ color: colors.textDim, fontSize: 15, lineHeight: 21 }, baseStyle]}>
            {renderInline(text, `q${bi}-`)}
          </Text>
        </View>,
      );
    } else {
      blocks.push(
        <Text key={`p${bi}`} style={[{ color: colors.text, fontSize: 15, lineHeight: 21 }, baseStyle]}>
          {renderInline(text, `p${bi}-`)}
        </Text>,
      );
    }
    bi++;
    buf = [];
  };
  for (const line of body.split('\n')) {
    const quoted = /^>\s?/.test(line);
    const nextKind: 'p' | 'q' = quoted ? 'q' : 'p';
    if (nextKind !== kind && buf.length) flush();
    kind = nextKind;
    buf.push(quoted ? line.replace(/^>\s?/, '') : line);
  }
  flush();
  return <View>{blocks}</View>;
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

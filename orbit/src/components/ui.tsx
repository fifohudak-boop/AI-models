import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { palette, radii, spacing } from '../theme';

export function Screen({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return <View style={[styles.screen, { backgroundColor: theme.bg }]}>{children}</View>;
}

export function Kicker({ children }: { children: string }) {
  const { theme } = useTheme();
  return <Text style={[styles.kicker, { color: theme.neutral[500] }]}>{children}</Text>;
}

export function ScreenTitle({ children }: { children: string }) {
  const { theme } = useTheme();
  return <Text style={[styles.title, { color: theme.text }]}>{children}</Text>;
}

export function Header({ kicker, title }: { kicker: string; title: string }) {
  return (
    <View style={{ paddingTop: 60, paddingHorizontal: 20, paddingBottom: 8 }}>
      <Kicker>{kicker}</Kicker>
      <ScreenTitle>{title}</ScreenTitle>
    </View>
  );
}

export function Card({ children, style, accent }: { children: React.ReactNode; style?: ViewStyle; accent?: boolean }) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: accent ? theme.accentSoft : theme.surface,
          borderColor: accent ? theme.accentRamp[700] : theme.neutral[800],
          borderWidth: 1,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'accent' | 'neutral' }) {
  const { theme } = useTheme();
  const isAccent = tone === 'accent';
  return (
    <View
      style={{
        borderRadius: radii.sm,
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderWidth: 1,
        borderColor: isAccent ? theme.accentRamp[600] : theme.neutral[800],
        backgroundColor: 'transparent',
      }}
    >
      <Text
        style={{
          fontSize: 10,
          letterSpacing: 1,
          fontWeight: '500',
          color: isAccent ? theme.accentRamp[300] : theme.neutral[600],
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function OutlineButton({
  label,
  onPress,
  block,
}: {
  label: string;
  onPress: () => void;
  block?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          borderWidth: 1,
          borderColor: theme.accent,
          borderRadius: radii.md,
          paddingVertical: 13,
          paddingHorizontal: 16,
          alignItems: 'center',
          opacity: pressed ? 0.7 : 1,
          width: block ? '100%' : undefined,
        },
      ]}
    >
      <Text style={{ color: theme.accentRamp[300], fontWeight: '500', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function ColorSwatchRow({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (color: string) => void;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 9, paddingLeft: 52, flexWrap: 'wrap' }}>
      {palette.map((c) => {
        const isSelected = c === selected;
        return (
          <Pressable
            key={c}
            onPress={() => onSelect(c)}
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: c,
              borderWidth: isSelected ? 2 : 0,
              borderColor: theme.bg,
              shadowColor: isSelected ? c : undefined,
            }}
          />
        );
      })}
    </View>
  );
}

export function ColorDotButton({
  color,
  onPress,
}: {
  color: string;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: theme.neutral[800],
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: color }} />
    </Pressable>
  );
}

export function useExpandable() {
  const [openId, setOpenId] = useState<string | null>(null);
  return {
    isOpen: (id: string) => openId === id,
    toggle: (id: string) => setOpenId((prev) => (prev === id ? null : id)),
    close: () => setOpenId(null),
  };
}

export function Checkbox({
  done,
  onPress,
  color,
  size = 26,
}: {
  done: boolean;
  onPress: () => void;
  color?: string;
  size?: number;
}) {
  const { theme } = useTheme();
  const fill = color ?? theme.accent;
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.23,
        backgroundColor: done ? fill : 'transparent',
        borderWidth: done ? 0 : 1.5,
        borderColor: theme.neutral[800],
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {done && <Text style={{ color: '#12131D', fontWeight: '700', fontSize: size * 0.55 }}>✓</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  kicker: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  title: { fontSize: 30, fontWeight: '500', letterSpacing: -0.4 },
  card: { borderRadius: radii.md, padding: spacing.md },
});

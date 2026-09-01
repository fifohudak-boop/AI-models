import React from 'react';
import { Pressable, Text } from 'react-native';
import { useTheme } from '../context/ThemeContext';

export function ThemeToggle() {
  const { theme, isDark, toggle } = useTheme();
  return (
    <Pressable
      onPress={toggle}
      style={{
        position: 'absolute',
        top: 58,
        right: 18,
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.neutral[800],
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
      }}
    >
      <Text style={{ fontSize: 15 }}>{isDark ? '🌙' : '☀️'}</Text>
    </Pressable>
  );
}

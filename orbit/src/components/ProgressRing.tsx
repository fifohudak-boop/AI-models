import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';

export function ProgressRing({ eaten, target }: { eaten: number; target: number }) {
  const { theme } = useTheme();
  const size = 124;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, eaten / target);
  const remaining = Math.max(0, target - eaten);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.neutral[800]} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={theme.accent}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c * pct} ${c}`}
          strokeLinecap="round"
        />
      </Svg>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Text style={{ fontSize: 25, fontWeight: '500', color: theme.text }}>{remaining}</Text>
        <Text style={{ fontSize: 12, color: theme.neutral[400], marginLeft: 3 }}>kcal</Text>
      </View>
      <Text style={{ fontSize: 10, color: theme.neutral[500], letterSpacing: 1, marginTop: 2 }}>LEFT TODAY</Text>
    </View>
  );
}

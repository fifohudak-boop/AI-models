import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Checkbox, Screen } from '../components/ui';
import { TrainStackParamList } from '../navigation/types';
import { focusMeta } from '../seed';

type Props = NativeStackScreenProps<TrainStackParamList, 'Session'>;

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function SessionScreen({ route, navigation }: Props) {
  const { theme } = useTheme();
  const { week, exercisesByFocus, toggleSet, markDayDone } = useData();
  const day = week[route.params.dayIndex];
  const focus = day.focus;
  const exercises = exercisesByFocus[focus] ?? [];
  const meta = focusMeta[focus];

  const [elapsed, setElapsed] = useState(0);
  const [rest, setRest] = useState<number | null>(null);
  const restRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (rest === null) return;
    if (rest <= 0) {
      setRest(null);
      return;
    }
    const t = setTimeout(() => setRest((r) => (r ?? 0) - 1), 1000);
    return () => clearTimeout(t);
  }, [rest]);

  const volume = exercises.reduce(
    (sum, ex) => sum + ex.sets.filter((s) => s.done).reduce((a, s) => a + s.weight * s.reps, 0),
    0
  );

  const handleToggleSet = (exIdx: number, setIdx: number, wasDone: boolean) => {
    toggleSet(focus, exIdx, setIdx);
    if (!wasDone) setRest(150);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 60, paddingHorizontal: 20 }}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={{ color: theme.accentRamp[300], fontSize: 13 }}>‹ Train</Text>
          </Pressable>
          <Text style={{ fontSize: 12, color: theme.accentRamp[300], marginTop: 8 }}>
            SESSION LIVE · {fmt(elapsed)}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 4 }}>
            <Text style={{ fontSize: 28, fontWeight: '500', color: theme.text }}>{meta.label}</Text>
            <Text style={{ fontSize: 12.5, color: theme.neutral[500] }}>{Math.round(volume)} kg moved</Text>
          </View>

          <Card accent style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 62, alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '500', color: theme.accentRamp[300] }}>
                {rest !== null ? fmt(rest) : '—:—'}
              </Text>
            </View>
            <Text style={{ flex: 1, fontSize: 12.5, color: theme.neutral[400] }}>
              {rest !== null ? 'Rest. Next set when this hits zero, not before.' : 'Tick a set and the clock starts.'}
            </Text>
            {rest !== null && (
              <Pressable onPress={() => setRest(null)}>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.accentRamp[300],
                    borderWidth: 1,
                    borderColor: theme.accentRamp[600],
                    borderRadius: 4,
                    paddingVertical: 4,
                    paddingHorizontal: 8,
                  }}
                >
                  Skip
                </Text>
              </Pressable>
            )}
          </Card>

          {exercises.map((ex, exIdx) => (
            <Card key={ex.name} style={{ marginTop: 16 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 14.5, fontWeight: '500', color: theme.text }}>{ex.name}</Text>
                <Text style={{ fontSize: 11.5, color: theme.neutral[500] }}>{ex.target}</Text>
              </View>
              {ex.sets.map((s, setIdx) => (
                <View
                  key={setIdx}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 10,
                    borderTopWidth: 1,
                    borderTopColor: theme.neutral[800],
                  }}
                >
                  <Text style={{ width: 26, fontSize: 11.5, color: theme.neutral[600] }}>{setIdx + 1}</Text>
                  <Text style={{ flex: 1, fontSize: 13.5, color: s.done ? theme.text : theme.neutral[600] }}>
                    {s.weight} kg
                  </Text>
                  <Text style={{ flex: 1, fontSize: 13.5, color: s.done ? theme.text : theme.neutral[600] }}>
                    {s.reps} reps
                  </Text>
                  <Checkbox done={s.done} onPress={() => handleToggleSet(exIdx, setIdx, s.done)} size={20} />
                </View>
              ))}
            </Card>
          ))}

          <Pressable
            onPress={() => markDayDone(route.params.dayIndex)}
            style={{
              marginTop: 20,
              borderWidth: 1,
              borderColor: theme.accent,
              borderRadius: 8,
              paddingVertical: 13,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: theme.accentRamp[300], fontWeight: '500' }}>
              {day.done ? 'Session marked done' : 'Mark session done'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

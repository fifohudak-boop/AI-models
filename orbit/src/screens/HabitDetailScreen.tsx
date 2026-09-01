import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Screen } from '../components/ui';
import { HabitsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<HabitsStackParamList, 'HabitDetail'>;

export default function HabitDetailScreen({ route, navigation }: Props) {
  const { theme } = useTheme();
  const { habits } = useData();
  const habit = habits.find((h) => h.id === route.params.habitId);
  if (!habit) return null;

  const best = Math.max(habit.streak, 63);
  const cells = Array.from({ length: 70 }, (_, i) => {
    const idx = 69 - i;
    if (idx < 6) return 'empty';
    const filled = idx < habit.streak + 6 ? (idx < 10 ? 'recent' : 'older') : 'empty';
    return filled;
  }).reverse();

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 60, paddingHorizontal: 20 }}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={{ color: theme.accentRamp[300], fontSize: 13 }}>‹ Habits</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: habit.color }} />
            <Text style={{ fontSize: 29, fontWeight: '500', color: theme.text }}>{habit.name}</Text>
          </View>
          <Text style={{ fontSize: 13, color: theme.neutral[500], marginTop: 4 }}>{habit.sub}</Text>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 20 }}>
            {[
              { key: 'STREAK', value: habit.streak },
              { key: 'BEST', value: best },
              { key: '90-DAY', value: '86%' },
            ].map((s) => (
              <Card key={s.key} style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 20, fontWeight: '500', color: habit.color }}>{s.value}</Text>
                <Text style={{ fontSize: 10, color: theme.neutral[600], letterSpacing: 1, marginTop: 4 }}>
                  {s.key}
                </Text>
              </Card>
            ))}
          </View>

          <Text style={{ fontSize: 11, color: theme.neutral[600], letterSpacing: 1, marginTop: 24, marginBottom: 10 }}>
            LAST 10 WEEKS
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
            {cells.map((c, i) => (
              <View
                key={i}
                style={{
                  width: '12.5%',
                  aspectRatio: 1,
                  borderRadius: 3,
                  backgroundColor:
                    c === 'recent' ? habit.color : c === 'older' ? theme.accentRamp[700] : theme.neutral[900],
                }}
              />
            ))}
          </View>

          <Card accent style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: theme.neutral[300] }}>
              {habit.done
                ? 'Ticked today. Do not celebrate a single day — the grid is what counts, and it looks clean.'
                : `Not ticked yet. Two more misses this month and the ${habit.streak}-day streak stops meaning anything. Go do it.`}
            </Text>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

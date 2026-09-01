import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { Card, Screen } from '../components/ui';
import { AreaChart } from '../components/LineChart';
import { TrainStackParamList } from '../navigation/types';
import { strengthSeries } from '../seed';

type Props = NativeStackScreenProps<TrainStackParamList, 'Strength'>;

const LIFTS = ['Bench press', 'Overhead press', 'Weighted dips'];

export default function StrengthScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const [lift, setLift] = useState(LIFTS[0]);
  const series = strengthSeries[lift];
  const delta = series[series.length - 1] - series[0];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 60, paddingHorizontal: 20 }}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={{ color: theme.accentRamp[300], fontSize: 13 }}>‹ Train</Text>
          </Pressable>
          <Text style={{ fontSize: 29, fontWeight: '500', color: theme.text, marginTop: 6, marginBottom: 16 }}>
            Strength
          </Text>

          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            {LIFTS.map((l) => {
              const selected = l === lift;
              return (
                <Pressable
                  key={l}
                  onPress={() => setLift(l)}
                  style={{
                    paddingVertical: 7,
                    paddingHorizontal: 12,
                    borderRadius: 99,
                    borderWidth: 1,
                    borderColor: selected ? theme.accent : theme.neutral[800],
                    backgroundColor: selected ? theme.accentSoft : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 12.5, color: selected ? theme.accentRamp[300] : theme.neutral[500] }}>
                    {l}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={{ fontSize: 26, fontWeight: '500', color: theme.text }}>{series[series.length - 1]} kg</Text>
              <Text style={{ fontSize: 12.5, color: theme.accent }}>
                +{delta} kg in {series.length} weeks
              </Text>
            </View>
            <View style={{ marginTop: 10 }}>
              <AreaChart values={series} color={theme.accent} fillColor="rgba(145,132,217,0.13)" />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={{ fontSize: 10.5, color: theme.neutral[600] }}>7 Jul</Text>
              <Text style={{ fontSize: 10.5, color: theme.neutral[600] }}>1 Sept</Text>
            </View>
          </Card>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            {[
              { key: 'TOP SET', value: `${series[series.length - 1]} kg` },
              { key: 'SESSIONS', value: series.length },
              { key: 'MISSED', value: 0 },
            ].map((s) => (
              <Card key={s.key} style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 18, fontWeight: '500', color: theme.text }}>{s.value}</Text>
                <Text style={{ fontSize: 9.5, color: theme.neutral[600], letterSpacing: 1, marginTop: 4 }}>
                  {s.key}
                </Text>
              </Card>
            ))}
          </View>

          <Card accent style={{ marginTop: 16 }}>
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: theme.neutral[300] }}>
              Nine weeks, no missed session. The jump stalls if you keep adding 2.5 kg every week — hold this load
              for two sessions, then push.
            </Text>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

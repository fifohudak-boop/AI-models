import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Header, Pill, Screen } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { Sparkline } from '../components/LineChart';
import { TrainStackParamList } from '../navigation/types';
import { focusMeta, strengthSeries, bodyWeightSeries } from '../seed';

type Props = NativeStackScreenProps<TrainStackParamList, 'TrainHome'>;

export default function TrainScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { week, cycleFocus } = useData();

  const doneCount = week.filter((d) => d.done).length;

  return (
    <Screen>
      <ThemeToggle />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Header kicker={`WEEK 36 · ${doneCount} OF 5 DONE`} title="Train" />
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <Pressable style={{ flex: 1 }} onPress={() => navigation.navigate('Strength')}>
              <Card>
                <Sparkline values={strengthSeries['Bench press']} color={theme.accent} />
                <Text style={{ fontSize: 13.5, fontWeight: '500', color: theme.text, marginTop: 8 }}>Strength</Text>
                <Text style={{ fontSize: 11.5, color: theme.neutral[500], marginTop: 2 }}>Bench 62.5 → 80 kg</Text>
              </Card>
            </Pressable>
            <Pressable style={{ flex: 1 }} onPress={() => navigation.navigate('BodyWeight')}>
              <Card>
                <Sparkline values={bodyWeightSeries} color="#7FB3A6" />
                <Text style={{ fontSize: 13.5, fontWeight: '500', color: theme.text, marginTop: 8 }}>Body weight</Text>
                <Text style={{ fontSize: 11.5, color: theme.neutral[500], marginTop: 2 }}>81.2 kg · +2.8 in 12 wk</Text>
              </Card>
            </Pressable>
          </View>

          <Text style={{ fontSize: 11, color: theme.neutral[600], letterSpacing: 1, marginBottom: 10 }}>
            THIS WEEK · TAP THE TAG TO CHANGE A DAY
          </Text>

          {week.map((d, i) => {
            const meta = focusMeta[d.focus];
            const isRest = d.focus === 'rest';
            return (
              <Card key={d.day} style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
                <Pressable
                  style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
                  onPress={() => !isRest && navigation.navigate('Session', { dayIndex: i })}
                >
                  <Text
                    style={{
                      width: 34,
                      fontSize: 11.5,
                      textTransform: 'uppercase',
                      color: d.done ? theme.accent : theme.neutral[600],
                    }}
                  >
                    {d.day}
                  </Text>
                  <View style={{ flex: 1, marginLeft: 6 }}>
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '500',
                        color: isRest ? theme.neutral[500] : theme.text,
                      }}
                    >
                      {meta.label}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: theme.neutral[500], marginTop: 2 }} numberOfLines={1}>
                      {meta.list}
                    </Text>
                  </View>
                </Pressable>
                <Pressable onPress={() => cycleFocus(i)}>
                  <Pill label={meta.label} tone={isRest ? 'neutral' : 'accent'} />
                </Pressable>
              </Card>
            );
          })}
        </View>
      </ScrollView>
    </Screen>
  );
}

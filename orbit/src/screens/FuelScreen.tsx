import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Header, OutlineButton, Screen } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { ProgressRing } from '../components/ProgressRing';
import { FuelStackParamList } from '../navigation/types';
import { calorieTarget } from '../seed';

type Props = NativeStackScreenProps<FuelStackParamList, 'FuelHome'>;

const MACROS = [
  { key: 'protein', label: 'Protein', color: '#9184D9', target: 190 },
  { key: 'carbs', label: 'Carbs', color: '#7FB3A6', target: 280 },
  { key: 'fat', label: 'Fat', color: '#D1A06B', target: 78 },
];

export default function FuelScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { meals } = useData();

  const eaten = meals.reduce((sum, m) => sum + m.kcal, 0);
  const protein = meals.reduce((sum, m) => sum + m.protein, 0);
  const carbsG = Math.round(eaten * 0.11);
  const fatG = Math.round(eaten * 0.035);
  const macroValues: Record<string, number> = { protein, carbs: carbsG, fat: fatG };

  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();

  return (
    <Screen>
      <ThemeToggle />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Header kicker={dayName} title="Fuel" />
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
            <ProgressRing eaten={eaten} target={calorieTarget} />
            <View style={{ flex: 1, gap: 12 }}>
              {MACROS.map((m) => {
                const value = macroValues[m.key];
                const pct = Math.min(1, value / m.target);
                return (
                  <View key={m.key}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 12, fontWeight: '500', color: m.color }}>{m.label}</Text>
                      <Text style={{ fontSize: 11.5, color: theme.neutral[500] }}>
                        {value}/{m.target}g
                      </Text>
                    </View>
                    <View style={{ height: 4, backgroundColor: theme.neutral[800], borderRadius: 99 }}>
                      <View
                        style={{
                          height: 4,
                          width: `${pct * 100}%`,
                          backgroundColor: m.color,
                          borderRadius: 99,
                        }}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>

          <Text style={{ fontSize: 11.5, color: theme.neutral[500], marginTop: 16 }}>
            {eaten} kcal eaten of {calorieTarget} kcal · {protein} g protein in
          </Text>

          <Text style={{ fontSize: 11, color: theme.neutral[600], letterSpacing: 1, marginTop: 24, marginBottom: 10 }}>
            LOGGED
          </Text>
          {meals.map((m) => (
            <Card key={m.id} style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ width: 38, fontSize: 11.5, color: theme.neutral[600] }}>{m.time}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '500', color: theme.text }}>{m.name}</Text>
                <Text style={{ fontSize: 12, color: theme.neutral[500], marginTop: 2 }} numberOfLines={1}>
                  {m.items}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 14, color: theme.text }}>{m.kcal} kcal</Text>
                <Text style={{ fontSize: 10.5, color: theme.neutral[600], marginTop: 2 }}>{m.protein} g P</Text>
              </View>
            </Card>
          ))}

          <View style={{ marginTop: 8 }}>
            <OutlineButton label="Log food" onPress={() => navigation.navigate('LogFood')} block />
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

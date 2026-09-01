import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Screen } from '../components/ui';
import { AreaChart } from '../components/LineChart';
import { TrainStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<TrainStackParamList, 'BodyWeight'>;

export default function BodyWeightScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { bodyWeight, logBodyWeight } = useData();
  const [value, setValue] = useState(String(bodyWeight[bodyWeight.length - 1]));

  const latest = bodyWeight[bodyWeight.length - 1];
  const first = bodyWeight[0];
  const delta = (latest - first).toFixed(1);
  const perWeek = ((latest - first) / bodyWeight.length).toFixed(2);

  const submit = () => {
    const kg = parseFloat(value);
    if (!isNaN(kg)) logBodyWeight(kg);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 60, paddingHorizontal: 20 }}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={{ color: theme.accentRamp[300], fontSize: 13 }}>‹ Train</Text>
          </Pressable>
          <Text style={{ fontSize: 29, fontWeight: '500', color: theme.text, marginTop: 6, marginBottom: 16 }}>
            Body weight
          </Text>

          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={{ fontSize: 26, fontWeight: '500', color: theme.text }}>{latest} kg</Text>
              <Text style={{ fontSize: 12.5, color: '#7FB3A6' }}>
                +{delta} kg · {bodyWeight.length} weeks
              </Text>
            </View>
            <View style={{ marginTop: 10 }}>
              <AreaChart values={bodyWeight} color="#7FB3A6" fillColor="rgba(127,179,166,0.13)" />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={{ fontSize: 10.5, color: theme.neutral[600] }}>9 Jun</Text>
              <Text style={{ fontSize: 10.5, color: theme.neutral[600] }}>1 Sept</Text>
            </View>
          </Card>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            {[
              { key: 'RATE', value: `${perWeek} kg/wk` },
              { key: 'TARGET', value: '83 kg' },
              { key: 'AT THIS RATE', value: '8 wk' },
            ].map((s) => (
              <Card key={s.key} style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 16, fontWeight: '500', color: theme.text }}>{s.value}</Text>
                <Text style={{ fontSize: 9.5, color: theme.neutral[600], letterSpacing: 1, marginTop: 4, textAlign: 'center' }}>
                  {s.key}
                </Text>
              </Card>
            ))}
          </View>

          <Card style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center' }}>
            <TextInput
              value={value}
              onChangeText={setValue}
              keyboardType="decimal-pad"
              style={{
                flex: 1,
                fontSize: 14,
                color: theme.text,
                backgroundColor: theme.neutral[900],
                borderWidth: 1,
                borderColor: theme.neutral[800],
                borderRadius: 8,
                padding: 11,
                marginRight: 10,
              }}
            />
            <Pressable
              onPress={submit}
              style={{
                borderWidth: 1,
                borderColor: theme.accent,
                borderRadius: 8,
                paddingVertical: 11,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ color: theme.accentRamp[300], fontWeight: '500' }}>Log</Text>
            </Pressable>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

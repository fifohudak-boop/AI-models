import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card } from '../components/ui';
import { FuelStackParamList } from '../navigation/types';
import { foodDb } from '../seed';

type Props = NativeStackScreenProps<FuelStackParamList, 'LogFood'>;

type Segment = 'Search' | 'Scan' | 'Manual';

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function LogFoodScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { addMeal } = useData();
  const [segment, setSegment] = useState<Segment>('Search');
  const [query, setQuery] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualKcal, setManualKcal] = useState('');
  const [manualProtein, setManualProtein] = useState('');

  const filtered = useMemo(
    () => foodDb.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())),
    [query]
  );

  const addFromDb = (item: (typeof foodDb)[number]) => {
    addMeal({ time: nowHHMM(), name: item.name, items: item.serving, kcal: item.kcal, protein: item.protein });
    navigation.goBack();
  };

  const addManual = () => {
    addMeal({
      time: nowHHMM(),
      name: manualName || 'Manual entry',
      items: 'Manual entry',
      kcal: Number(manualKcal) || 0,
      protein: Number(manualProtein) || 0,
    });
    navigation.goBack();
  };

  const simulateScan = () => {
    const item = foodDb[0];
    addFromDb(item);
  };

  return (
    <View style={{ flex: 1, backgroundColor: 'rgba(9,10,18,0.55)' }}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: theme.surface,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: '80%',
            paddingBottom: 24,
          }}
        >
          <View
            style={{
              width: 38,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.neutral[700],
              alignSelf: 'center',
              marginTop: 10,
            }}
          />
          <Text style={{ fontSize: 18, fontWeight: '500', color: theme.text, textAlign: 'center', marginTop: 12 }}>
            Log food
          </Text>

          <View
            style={{
              flexDirection: 'row',
              margin: 16,
              backgroundColor: theme.neutral[900],
              borderRadius: 8,
              padding: 3,
            }}
          >
            {(['Search', 'Scan', 'Manual'] as Segment[]).map((s) => (
              <Pressable
                key={s}
                onPress={() => setSegment(s)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 6,
                  alignItems: 'center',
                  backgroundColor: segment === s ? theme.accentRamp[800] : 'transparent',
                }}
              >
                <Text style={{ color: segment === s ? theme.accentRamp[300] : theme.neutral[500], fontSize: 13 }}>
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView style={{ paddingHorizontal: 16 }}>
            {segment === 'Search' && (
              <View>
                <TextInput
                  placeholder="chicken, rice, whey…"
                  placeholderTextColor={theme.neutral[600]}
                  value={query}
                  onChangeText={setQuery}
                  style={{
                    backgroundColor: theme.neutral[900],
                    borderWidth: 1,
                    borderColor: theme.neutral[800],
                    borderRadius: 8,
                    padding: 12,
                    color: theme.text,
                    marginBottom: 12,
                  }}
                />
                {filtered.map((item) => (
                  <Card key={item.name} style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13.5, fontWeight: '500', color: theme.text }}>{item.name}</Text>
                      <Text style={{ fontSize: 11.5, color: theme.neutral[500], marginTop: 2 }}>{item.serving}</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: theme.neutral[500], marginRight: 10 }}>
                      {item.kcal} kcal · {item.protein}g P
                    </Text>
                    <Pressable
                      onPress={() => addFromDb(item)}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: theme.accentRamp[600],
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: theme.accentRamp[300], fontSize: 15, lineHeight: 15 }}>+</Text>
                    </Pressable>
                  </Card>
                ))}
              </View>
            )}

            {segment === 'Scan' && (
              <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                <View
                  style={{
                    width: 200,
                    height: 200,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: theme.accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.neutral[900],
                  }}
                >
                  <Text style={{ fontSize: 40 }}>▮▯▮▮▯▮▮▯</Text>
                </View>
                <Text style={{ fontSize: 12.5, color: theme.neutral[500], marginTop: 12, textAlign: 'center' }}>
                  Hold the barcode inside the frame
                </Text>
                <Pressable
                  onPress={simulateScan}
                  style={{
                    marginTop: 16,
                    borderWidth: 1,
                    borderColor: theme.accent,
                    borderRadius: 8,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                  }}
                >
                  <Text style={{ color: theme.accentRamp[300] }}>Simulate scan</Text>
                </Pressable>
              </View>
            )}

            {segment === 'Manual' && (
              <View>
                <TextInput
                  placeholder="Name"
                  placeholderTextColor={theme.neutral[600]}
                  value={manualName}
                  onChangeText={setManualName}
                  style={{
                    backgroundColor: theme.neutral[900],
                    borderWidth: 1,
                    borderColor: theme.neutral[800],
                    borderRadius: 8,
                    padding: 12,
                    color: theme.text,
                    marginBottom: 10,
                  }}
                />
                <TextInput
                  placeholder="kcal"
                  placeholderTextColor={theme.neutral[600]}
                  value={manualKcal}
                  onChangeText={setManualKcal}
                  keyboardType="decimal-pad"
                  style={{
                    backgroundColor: theme.neutral[900],
                    borderWidth: 1,
                    borderColor: theme.neutral[800],
                    borderRadius: 8,
                    padding: 12,
                    color: theme.text,
                    marginBottom: 10,
                  }}
                />
                <TextInput
                  placeholder="Protein g"
                  placeholderTextColor={theme.neutral[600]}
                  value={manualProtein}
                  onChangeText={setManualProtein}
                  keyboardType="decimal-pad"
                  style={{
                    backgroundColor: theme.neutral[900],
                    borderWidth: 1,
                    borderColor: theme.neutral[800],
                    borderRadius: 8,
                    padding: 12,
                    color: theme.text,
                    marginBottom: 14,
                  }}
                />
                <Pressable
                  onPress={addManual}
                  style={{
                    borderWidth: 1,
                    borderColor: theme.accent,
                    borderRadius: 8,
                    paddingVertical: 13,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: theme.accentRamp[300], fontWeight: '500' }}>Add to today</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

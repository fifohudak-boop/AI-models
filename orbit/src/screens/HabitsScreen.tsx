import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Checkbox, ColorDotButton, ColorSwatchRow, Header, useExpandable } from '../components/ui';
import { Screen } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { HabitsStackParamList } from '../navigation/types';
import { palette } from '../theme';

type Props = NativeStackScreenProps<HabitsStackParamList, 'HabitsHome'>;

export default function HabitsScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { habits, toggleHabit, setHabitColor, addHabit } = useData();
  const palettes = useExpandable();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [color, setColor] = useState(palette[0]);

  const doneCount = habits.filter((h) => h.done).length;

  const submit = () => {
    addHabit(name, target, color);
    setName('');
    setTarget('');
    setColor(palette[0]);
    setCreating(false);
  };

  return (
    <Screen>
      <ThemeToggle />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Header kicker="STREAKS HOLD OR THEY BREAK" title="Habits" />
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View style={{ flex: 1, height: 5, backgroundColor: theme.neutral[800], borderRadius: 99 }}>
              <View
                style={{
                  height: 5,
                  width: `${(doneCount / habits.length) * 100}%`,
                  backgroundColor: theme.accent,
                  borderRadius: 99,
                }}
              />
            </View>
            <Text style={{ marginLeft: 10, fontSize: 12.5, color: theme.neutral[400] }}>
              {doneCount} / {habits.length}
            </Text>
          </View>

          {habits.map((h) => (
            <Card key={h.id} style={{ marginBottom: 9 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Checkbox done={h.done} onPress={() => toggleHabit(h.id)} color={h.color} />
                <Pressable
                  style={{ flex: 1, marginLeft: 10 }}
                  onPress={() => navigation.navigate('HabitDetail', { habitId: h.id })}
                >
                  <Text style={{ fontSize: 14.5, fontWeight: '500', color: theme.text }}>{h.name}</Text>
                  <Text style={{ fontSize: 12, color: theme.neutral[500], marginTop: 2 }}>{h.sub}</Text>
                </Pressable>
                <View style={{ alignItems: 'center', marginRight: 10 }}>
                  <Text style={{ fontSize: 15, fontWeight: '500', color: h.color }}>{h.streak}</Text>
                  <Text style={{ fontSize: 9.5, color: theme.neutral[600], letterSpacing: 1 }}>DAYS</Text>
                </View>
                <ColorDotButton color={h.color} onPress={() => palettes.toggle(h.id)} />
              </View>
              {palettes.isOpen(h.id) && (
                <View style={{ marginTop: 12 }}>
                  <ColorSwatchRow
                    selected={h.color}
                    onSelect={(c) => {
                      setHabitColor(h.id, c);
                      palettes.close();
                    }}
                  />
                </View>
              )}
            </Card>
          ))}

          {!creating ? (
            <Pressable
              onPress={() => setCreating(true)}
              style={{
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: theme.neutral[700],
                borderRadius: 8,
                padding: 14,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: theme.neutral[500], fontSize: 13.5 }}>+ New habit</Text>
            </Pressable>
          ) : (
            <Card>
              <TextInput
                placeholder="Name"
                placeholderTextColor={theme.neutral[600]}
                value={name}
                onChangeText={setName}
                style={{
                  backgroundColor: theme.neutral[900],
                  borderWidth: 1,
                  borderColor: theme.neutral[800],
                  borderRadius: 8,
                  padding: 11,
                  color: theme.text,
                  fontSize: 14,
                  marginBottom: 8,
                }}
              />
              <TextInput
                placeholder="Target"
                placeholderTextColor={theme.neutral[600]}
                value={target}
                onChangeText={setTarget}
                style={{
                  backgroundColor: theme.neutral[900],
                  borderWidth: 1,
                  borderColor: theme.neutral[800],
                  borderRadius: 8,
                  padding: 11,
                  color: theme.text,
                  fontSize: 14,
                  marginBottom: 10,
                }}
              />
              <ColorSwatchRow selected={color} onSelect={setColor} />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <Pressable
                  onPress={() => setCreating(false)}
                  style={{ flex: 1, alignItems: 'center', padding: 12 }}
                >
                  <Text style={{ color: theme.neutral[500] }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submit}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    padding: 12,
                    borderWidth: 1,
                    borderColor: theme.accent,
                    borderRadius: 8,
                  }}
                >
                  <Text style={{ color: theme.accentRamp[300], fontWeight: '500' }}>Add habit</Text>
                </Pressable>
              </View>
            </Card>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

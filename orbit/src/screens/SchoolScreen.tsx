import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Checkbox, Kicker, Screen } from '../components/ui';
import { TodayStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<TodayStackParamList, 'School'>;

export default function SchoolScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const { exams, deadlines, toggleDeadline } = useData();

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingTop: 60, paddingHorizontal: 20, paddingBottom: 8 }}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={{ color: theme.accentRamp[300], fontSize: 13 }}>‹ Today</Text>
          </Pressable>
          <Text style={{ fontSize: 29, fontWeight: '500', color: theme.text, marginTop: 6 }}>School</Text>
        </View>

        <View style={{ paddingHorizontal: 20 }}>
          <Kicker>EXAMS</Kicker>
          {exams.map((exam) => (
            <Card key={exam.id} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row' }}>
                <View style={{ width: 52, alignItems: 'center' }}>
                  <Text style={{ fontSize: 23, fontWeight: '500', color: theme.accentRamp[300] }}>{exam.days}</Text>
                  <Text style={{ fontSize: 9, color: theme.neutral[600], letterSpacing: 1 }}>DAYS</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={{ fontSize: 14.5, fontWeight: '500', color: theme.text }}>{exam.name}</Text>
                  <Text style={{ fontSize: 12, color: theme.neutral[500], marginTop: 2 }}>{exam.meta}</Text>
                </View>
              </View>
              <View style={{ height: 3, backgroundColor: theme.neutral[800], borderRadius: 99, marginTop: 12 }}>
                <View
                  style={{
                    height: 3,
                    width: `${exam.prep}%`,
                    backgroundColor: theme.accentRamp[600],
                    borderRadius: 99,
                  }}
                />
              </View>
              <Text style={{ fontSize: 10.5, color: theme.neutral[600], marginTop: 6 }}>{exam.caption}</Text>
            </Card>
          ))}

          <Kicker>DEADLINES</Kicker>
          {deadlines.map((d) => (
            <Pressable key={d.id} onPress={() => toggleDeadline(d.id)}>
              <Card style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
                <Checkbox done={d.done} onPress={() => toggleDeadline(d.id)} size={22} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '500',
                      color: d.done ? theme.neutral[600] : theme.text,
                      textDecorationLine: d.done ? 'line-through' : 'none',
                    }}
                  >
                    {d.name}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.neutral[500], marginTop: 2 }}>{d.meta}</Text>
                </View>
                <Text
                  style={{
                    fontSize: 11.5,
                    color: d.done ? theme.neutral[600] : d.dueToday ? theme.accentRamp[300] : theme.neutral[600],
                  }}
                >
                  {d.due}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

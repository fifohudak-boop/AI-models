import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useTheme } from '../context/ThemeContext';
import { Card, Header, Pill, Screen } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { timelineRows } from '../seed';
import { TodayStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<TodayStackParamList, 'TodayHome'>;

function PulseDot({ color }: { color: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 2.4, duration: 2000, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0, duration: 2000, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.45, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <View style={{ width: 9, height: 9, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: 9,
          height: 9,
          borderRadius: 4.5,
          backgroundColor: color,
          opacity,
          transform: [{ scale }],
        }}
      />
      <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: color }} />
    </View>
  );
}

export default function TodayScreen(_: Props) {
  const { theme } = useTheme();
  const rootNav = useNavigation<any>();
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const dateStr = `${now.getDate()} ${now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}`;

  const goTo = (target: string) => {
    if (target === 'School') {
      _.navigation.navigate('School');
      return;
    }
    const tabMap: Record<string, string> = {
      Habits: 'HabitsTab',
      Notes: 'NotesTab',
      Fuel: 'FuelTab',
      Train: 'TrainTab',
    };
    const tab = tabMap[target];
    if (tab) rootNav.navigate(tab);
  };

  return (
    <Screen>
      <ThemeToggle />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Header kicker={`${dayName} · ${dateStr}`} title="Today" />
        <View style={{ paddingHorizontal: 20 }}>
          {timelineRows.map((row, i) => {
            const isLast = i === timelineRows.length - 1;
            const railColor =
              row.state === 'done' || row.state === 'current' ? theme.accent : 'transparent';
            return (
              <Pressable
                key={row.time + row.title}
                onPress={() => goTo(row.target)}
                style={{ flexDirection: 'row' }}
              >
                <View style={{ width: 44, paddingTop: 13 }}>
                  <Text style={{ fontSize: 12, color: theme.neutral[500] }}>{row.time}</Text>
                </View>
                <View style={{ width: 18, alignItems: 'center' }}>
                  <View style={{ height: 15 }} />
                  {row.state === 'current' ? (
                    <PulseDot color={theme.accent} />
                  ) : (
                    <View
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 4.5,
                        backgroundColor: railColor,
                        borderWidth: railColor === 'transparent' ? 1 : 0,
                        borderColor: theme.neutral[700],
                      }}
                    />
                  )}
                  {!isLast && <View style={{ width: 1, flex: 1, backgroundColor: theme.neutral[800], marginTop: 2 }} />}
                </View>
                <View style={{ flex: 1, paddingLeft: 12, paddingBottom: 14 }}>
                  <Card
                    accent={row.state === 'current'}
                    style={{
                      borderColor: row.state === 'current' ? theme.accentRamp[700] : theme.neutral[800],
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 14.5, fontWeight: '500', color: theme.text, letterSpacing: -0.1 }}>
                        {row.title}
                      </Text>
                      {row.state === 'urgent' && <Pill label="DUE" tone="accent" />}
                    </View>
                    <Text style={{ fontSize: 12.5, color: theme.neutral[500], marginTop: 4 }}>{row.meta}</Text>
                  </Card>
                </View>
              </Pressable>
            );
          })}

          <Pressable onPress={() => _.navigation.navigate('School')}>
            <Card accent style={{ marginLeft: 62, marginTop: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View>
                  <Text style={{ fontSize: 13.5, fontWeight: '500', color: theme.accentRamp[300] }}>
                    School agenda
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.neutral[500], marginTop: 2 }}>
                    2 exams · 3 deadlines open
                  </Text>
                </View>
                <Text style={{ fontSize: 17, color: theme.accentRamp[300] }}>›</Text>
              </View>
            </Card>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

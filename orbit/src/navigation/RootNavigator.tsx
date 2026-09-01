import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

import TodayScreen from '../screens/TodayScreen';
import SchoolScreen from '../screens/SchoolScreen';
import HabitsScreen from '../screens/HabitsScreen';
import HabitDetailScreen from '../screens/HabitDetailScreen';
import FuelScreen from '../screens/FuelScreen';
import LogFoodScreen from '../screens/LogFoodScreen';
import TrainScreen from '../screens/TrainScreen';
import SessionScreen from '../screens/SessionScreen';
import StrengthScreen from '../screens/StrengthScreen';
import BodyWeightScreen from '../screens/BodyWeightScreen';
import NotesScreen from '../screens/NotesScreen';
import FolderScreen from '../screens/FolderScreen';

import {
  FuelStackParamList,
  HabitsStackParamList,
  NotesStackParamList,
  TodayStackParamList,
  TrainStackParamList,
} from './types';

const TodayStack = createNativeStackNavigator<TodayStackParamList>();
const HabitsStack = createNativeStackNavigator<HabitsStackParamList>();
const FuelStack = createNativeStackNavigator<FuelStackParamList>();
const TrainStack = createNativeStackNavigator<TrainStackParamList>();
const NotesStack = createNativeStackNavigator<NotesStackParamList>();
const Tab = createBottomTabNavigator();

function TodayStackScreen() {
  return (
    <TodayStack.Navigator screenOptions={{ headerShown: false }}>
      <TodayStack.Screen name="TodayHome" component={TodayScreen} />
      <TodayStack.Screen name="School" component={SchoolScreen} />
    </TodayStack.Navigator>
  );
}

function HabitsStackScreen() {
  return (
    <HabitsStack.Navigator screenOptions={{ headerShown: false }}>
      <HabitsStack.Screen name="HabitsHome" component={HabitsScreen} />
      <HabitsStack.Screen name="HabitDetail" component={HabitDetailScreen} />
    </HabitsStack.Navigator>
  );
}

function FuelStackScreen() {
  return (
    <FuelStack.Navigator screenOptions={{ headerShown: false }}>
      <FuelStack.Screen name="FuelHome" component={FuelScreen} />
      <FuelStack.Screen
        name="LogFood"
        component={LogFoodScreen}
        options={{ presentation: 'transparentModal', animation: 'fade' }}
      />
    </FuelStack.Navigator>
  );
}

function TrainStackScreen() {
  return (
    <TrainStack.Navigator screenOptions={{ headerShown: false }}>
      <TrainStack.Screen name="TrainHome" component={TrainScreen} />
      <TrainStack.Screen name="Session" component={SessionScreen} />
      <TrainStack.Screen name="Strength" component={StrengthScreen} />
      <TrainStack.Screen name="BodyWeight" component={BodyWeightScreen} />
    </TrainStack.Navigator>
  );
}

function NotesStackScreen() {
  return (
    <NotesStack.Navigator screenOptions={{ headerShown: false }}>
      <NotesStack.Screen name="NotesHome" component={NotesScreen} />
      <NotesStack.Screen name="Folder" component={FolderScreen} />
    </NotesStack.Navigator>
  );
}

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  TodayTab: 'calendar-outline',
  HabitsTab: 'checkmark-circle-outline',
  FuelTab: 'restaurant-outline',
  TrainTab: 'barbell-outline',
  NotesTab: 'document-text-outline',
};

export default function RootNavigator() {
  const { theme } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.accentRamp[300],
        tabBarInactiveTintColor: theme.neutral[600],
        tabBarStyle: {
          backgroundColor: theme.tabBar,
          borderTopColor: theme.neutral[800],
          borderTopWidth: 1,
          height: 82,
          paddingTop: 9,
          paddingBottom: 26,
        },
        tabBarLabelStyle: { fontSize: 9.5, marginTop: 2 },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={ICONS[route.name]} color={color} size={21} />
        ),
      })}
    >
      <Tab.Screen name="TodayTab" component={TodayStackScreen} options={{ title: 'Today' }} />
      <Tab.Screen name="HabitsTab" component={HabitsStackScreen} options={{ title: 'Habits' }} />
      <Tab.Screen name="FuelTab" component={FuelStackScreen} options={{ title: 'Fuel' }} />
      <Tab.Screen name="TrainTab" component={TrainStackScreen} options={{ title: 'Train' }} />
      <Tab.Screen name="NotesTab" component={NotesStackScreen} options={{ title: 'Notes' }} />
    </Tab.Navigator>
  );
}

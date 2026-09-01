import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  seedHabits, seedMeals, calorieTarget, seedWeek, seedExercises,
  bodyWeightSeries, seedFolders, seedDeadlines, seedExams,
} from '../seed';
import { DayPlan, Deadline, Exam, Exercise, Folder, Habit, Meal, Note } from '../types';

type Data = {
  habits: Habit[];
  meals: Meal[];
  week: DayPlan[];
  exercisesByFocus: Record<string, Exercise[]>;
  bodyWeight: number[];
  folders: Folder[];
  deadlines: Deadline[];
  exams: Exam[];
};

type DataCtx = Data & {
  toggleHabit: (id: string) => void;
  setHabitColor: (id: string, color: string) => void;
  addHabit: (name: string, sub: string, color: string) => void;
  addMeal: (m: Omit<Meal, 'id'>) => void;
  cycleFocus: (dayIndex: number) => void;
  toggleSet: (focus: string, exerciseIdx: number, setIdx: number) => void;
  toggleDeadline: (id: string) => void;
  setFolderColor: (id: string, color: string) => void;
  addFolder: (name: string, color: string) => void;
  addNote: (folderId: string, note: Note) => void;
  logBodyWeight: (kg: number) => void;
  markDayDone: (dayIndex: number) => void;
};

const Ctx = createContext<DataCtx | null>(null);
const KEY = 'orbit.data.v1';

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Data>({
    habits: seedHabits,
    meals: seedMeals,
    week: seedWeek,
    exercisesByFocus: seedExercises,
    bodyWeight: bodyWeightSeries,
    folders: seedFolders,
    deadlines: seedDeadlines,
    exams: seedExams,
  });
  const loaded = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((raw) => {
      if (raw) {
        try {
          setData(JSON.parse(raw));
        } catch {}
      }
      loaded.current = true;
    });
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    AsyncStorage.setItem(KEY, JSON.stringify(data));
  }, [data]);

  const toggleHabit = (id: string) =>
    setData((d) => ({
      ...d,
      habits: d.habits.map((h) =>
        h.id === id ? { ...h, done: !h.done, streak: h.done ? Math.max(0, h.streak - 1) : h.streak + 1 } : h
      ),
    }));

  const setHabitColor = (id: string, color: string) =>
    setData((d) => ({ ...d, habits: d.habits.map((h) => (h.id === id ? { ...h, color } : h)) }));

  const addHabit = (name: string, sub: string, color: string) =>
    setData((d) => ({
      ...d,
      habits: [
        ...d.habits,
        { id: uid(), name: name.trim() || 'New habit', sub: sub.trim() || 'No target set', streak: 0, done: false, color },
      ],
    }));

  const addMeal = (m: Omit<Meal, 'id'>) =>
    setData((d) => ({ ...d, meals: [...d.meals, { ...m, id: uid() }] }));

  const cycleFocus = (dayIndex: number) =>
    setData((d) => {
      const order = ['pushA', 'pullA', 'legs', 'rest'];
      const week = d.week.map((day, i) => {
        if (i !== dayIndex) return day;
        const next = order[(order.indexOf(day.focus) + 1) % order.length];
        return { ...day, focus: next as DayPlan['focus'] };
      });
      return { ...d, week };
    });

  const markDayDone = (dayIndex: number) =>
    setData((d) => ({
      ...d,
      week: d.week.map((day, i) => (i === dayIndex ? { ...day, done: true } : day)),
    }));

  const toggleSet = (focus: string, exerciseIdx: number, setIdx: number) =>
    setData((d) => {
      const list = d.exercisesByFocus[focus] ?? [];
      const nextList = list.map((ex, i) => {
        if (i !== exerciseIdx) return ex;
        const sets = ex.sets.map((s, j) => (j === setIdx ? { ...s, done: !s.done } : s));
        return { ...ex, sets };
      });
      return { ...d, exercisesByFocus: { ...d.exercisesByFocus, [focus]: nextList } };
    });

  const toggleDeadline = (id: string) =>
    setData((d) => ({
      ...d,
      deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, done: !x.done } : x)),
    }));

  const setFolderColor = (id: string, color: string) =>
    setData((d) => ({ ...d, folders: d.folders.map((f) => (f.id === id ? { ...f, color } : f)) }));

  const addFolder = (name: string, color: string) =>
    setData((d) => ({
      ...d,
      folders: [...d.folders, { id: uid(), name: name.trim() || 'New folder', color, notes: [] }],
    }));

  const addNote = (folderId: string, note: Note) =>
    setData((d) => ({
      ...d,
      folders: d.folders.map((f) => (f.id === folderId ? { ...f, notes: [note, ...f.notes] } : f)),
    }));

  const logBodyWeight = (kg: number) =>
    setData((d) => ({ ...d, bodyWeight: [...d.bodyWeight.slice(1), kg] }));

  return (
    <Ctx.Provider
      value={{
        ...data,
        toggleHabit,
        setHabitColor,
        addHabit,
        addMeal,
        cycleFocus,
        toggleSet,
        toggleDeadline,
        setFolderColor,
        addFolder,
        addNote,
        logBodyWeight,
        markDayDone,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useData() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}

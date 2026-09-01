export type Habit = {
  id: string;
  name: string;
  sub: string;
  streak: number;
  done: boolean;
  color: string;
};

export type Meal = {
  id: string;
  time: string;
  name: string;
  items: string;
  kcal: number;
  protein: number;
};

export type FocusKey = 'pushA' | 'pullA' | 'legs' | 'rest';

export type DayPlan = {
  day: string;
  focus: FocusKey;
  done: boolean;
};

export type SetEntry = { weight: number; reps: number; done: boolean };
export type Exercise = { name: string; target: string; sets: SetEntry[] };

export type Note = { title: string; when: string; body: string };
export type Folder = { id: string; name: string; color: string; notes: Note[] };

export type Deadline = { id: string; name: string; meta: string; due: string; done: boolean; dueToday?: boolean };
export type Exam = { id: string; name: string; days: number; meta: string; prep: number; caption: string };

export type FoodItem = { name: string; serving: string; kcal: number; protein: number };

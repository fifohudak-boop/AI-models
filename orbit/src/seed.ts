import { categoryColors } from './theme';
import { Deadline, Exam, Exercise, Folder, Habit, Meal, DayPlan, FoodItem } from './types';

export const seedHabits: Habit[] = [
  { id: 'water', name: 'Water — 3L', sub: '2.1 of 3 L today', streak: 41, done: true, color: categoryColors.blue },
  { id: 'creatine', name: 'Creatine 5g', sub: 'With breakfast', streak: 118, done: true, color: categoryColors.blurple },
  { id: 'read', name: 'Read 20 min', sub: 'Evening block', streak: 12, done: false, color: categoryColors.amber },
  { id: 'nophone', name: 'No phone before 9:00', sub: 'Broken twice this week', streak: 3, done: false, color: categoryColors.rose },
  { id: 'steps', name: '10k steps', sub: '6 420 so far', streak: 27, done: false, color: categoryColors.teal },
];

export const seedMeals: Meal[] = [
  { id: 'breakfast', time: '07:20', name: 'Breakfast', items: 'Oats 90g · whey · banana · peanut butter', kcal: 640, protein: 44 },
  { id: 'lunch', time: '12:40', name: 'Lunch', items: 'Rice 200g · chicken thigh 220g · salad', kcal: 780, protein: 62 },
];

export const calorieTarget = 2600;

export const seedWeek: DayPlan[] = [
  { day: 'Mon', focus: 'pushA', done: true },
  { day: 'Tue', focus: 'pullA', done: true },
  { day: 'Wed', focus: 'pushA', done: false },
  { day: 'Thu', focus: 'legs', done: false },
  { day: 'Fri', focus: 'pullA', done: false },
  { day: 'Sat', focus: 'rest', done: false },
  { day: 'Sun', focus: 'rest', done: false },
];

export const focusMeta: Record<string, { label: string; list: string }> = {
  pushA: { label: 'Push A', list: 'Bench · OHP · Incline DB · Dips' },
  pullA: { label: 'Pull A', list: 'Rows · Pull-ups · Curls' },
  legs: { label: 'Legs', list: 'Squat · RDL · Calves' },
  rest: { label: 'REST', list: 'Walk 40 min · stretch' },
};

export const focusCycle: string[] = ['pushA', 'pullA', 'legs', 'rest'];

export const seedExercises: Record<string, Exercise[]> = {
  pushA: [
    { name: 'Bench press', target: '4 × 8 @ 80 kg', sets: [
      { weight: 80, reps: 8, done: true },
      { weight: 80, reps: 8, done: true },
      { weight: 80, reps: 7, done: true },
      { weight: 80, reps: 8, done: false },
    ] },
    { name: 'Overhead press', target: '4 × 6 @ 47.5 kg', sets: [
      { weight: 47.5, reps: 6, done: false },
      { weight: 47.5, reps: 6, done: false },
      { weight: 47.5, reps: 6, done: false },
      { weight: 47.5, reps: 6, done: false },
    ] },
    { name: 'Weighted dips', target: '3 × 10 @ +15 kg', sets: [
      { weight: 15, reps: 10, done: false },
      { weight: 15, reps: 10, done: false },
      { weight: 15, reps: 10, done: false },
    ] },
  ],
  pullA: [
    { name: 'Barbell rows', target: '4 × 8 @ 70 kg', sets: [
      { weight: 70, reps: 8, done: false },
      { weight: 70, reps: 8, done: false },
      { weight: 70, reps: 8, done: false },
      { weight: 70, reps: 8, done: false },
    ] },
    { name: 'Pull-ups', target: '4 × 8 @ BW', sets: [
      { weight: 0, reps: 8, done: false },
      { weight: 0, reps: 8, done: false },
      { weight: 0, reps: 8, done: false },
      { weight: 0, reps: 8, done: false },
    ] },
    { name: 'Curls', target: '3 × 12 @ 16 kg', sets: [
      { weight: 16, reps: 12, done: false },
      { weight: 16, reps: 12, done: false },
      { weight: 16, reps: 12, done: false },
    ] },
  ],
  legs: [
    { name: 'Squat', target: '4 × 6 @ 100 kg', sets: [
      { weight: 100, reps: 6, done: false },
      { weight: 100, reps: 6, done: false },
      { weight: 100, reps: 6, done: false },
      { weight: 100, reps: 6, done: false },
    ] },
    { name: 'RDL', target: '3 × 8 @ 90 kg', sets: [
      { weight: 90, reps: 8, done: false },
      { weight: 90, reps: 8, done: false },
      { weight: 90, reps: 8, done: false },
    ] },
    { name: 'Calves', target: '4 × 15 @ 60 kg', sets: [
      { weight: 60, reps: 15, done: false },
      { weight: 60, reps: 15, done: false },
      { weight: 60, reps: 15, done: false },
      { weight: 60, reps: 15, done: false },
    ] },
  ],
  rest: [],
};

export const strengthSeries: Record<string, number[]> = {
  'Bench press': [62.5, 65, 67.5, 70, 70, 72.5, 75, 77.5, 80],
  'Overhead press': [37.5, 40, 40, 42.5, 42.5, 45, 45, 47.5, 47.5],
  'Weighted dips': [0, 2.5, 5, 5, 7.5, 10, 10, 12.5, 15],
};

export const bodyWeightSeries: number[] = [
  78.4, 78.6, 78.9, 79.1, 79.0, 79.6, 79.9, 80.1, 80.4, 80.6, 81.0, 81.2,
];

export const seedFolders: Folder[] = [
  { id: 'personal', name: 'Personal', color: categoryColors.blurple, notes: [
    { title: 'Flight details', when: '2d', body: 'Departure 06:40, terminal 2, seat 14C. Print the boarding pass this time.' },
    { title: 'Gift ideas', when: '1w', body: 'Notebook, the coffee grinder, a hiking pole for the trip in October.' },
  ] },
  { id: 'buy', name: 'Buy', color: categoryColors.teal, notes: [
    { title: 'Groceries', when: '4h', body: 'Eggs, oats, chicken thigh, olive oil, bananas.' },
    { title: 'Gym gear', when: '3d', body: 'Lifting straps, chalk, a second pair of shorts.' },
  ] },
  { id: 'work', name: 'Work', color: categoryColors.amber, notes: [
    { title: 'Sprint retro', when: '1d', body: 'Bring up the deploy delay from Tuesday. Ask about the on-call rotation.' },
    { title: 'Onboarding doc', when: '5d', body: 'Draft outline done, needs the environment setup section.' },
    { title: '1:1 notes', when: '1w', body: 'Discussed the Q4 roadmap and the new hire.' },
  ] },
  { id: 'school', name: 'School', color: categoryColors.blue, notes: [
    { title: 'Linear Algebra — eigenvalues', when: '2d', body: 'Diagonalization only works when eigenvectors span the space. Review proof.' },
    { title: 'Ethics essay outline', when: '4d', body: 'Thesis, three arguments, one counter, conclusion. 2000 words.' },
  ] },
  { id: 'ideas', name: 'Ideas', color: categoryColors.rose, notes: [
    { title: 'App idea', when: '2w', body: 'A habit tracker that is blunt instead of encouraging. Working title: Orbit.' },
  ] },
];

export const seedDeadlines: Deadline[] = [
  { id: 'd1', name: 'Stats problem set 4', meta: 'Statistics · upload to portal', due: 'Today 15:00', done: false, dueToday: true },
  { id: 'd2', name: 'Essay — Ethics of AI', meta: '2 000 words · draft exists', due: 'Friday', done: false },
  { id: 'd3', name: 'Lab report 2', meta: 'Physics · handed in', due: 'Done', done: true },
];

export const seedExams: Exam[] = [
  { id: 'e1', name: 'Linear Algebra', days: 12, meta: '14 Sept · 09:00 · Hall C', prep: 45, caption: '45% of the revision plan done — behind by two sessions' },
  { id: 'e2', name: 'Statistics', days: 26, meta: '28 Sept · 13:00 · Hall A', prep: 20, caption: '20% done — comfortable, for now' },
];

export const foodDb: FoodItem[] = [
  { name: 'Chicken breast grilled', serving: '150 g', kcal: 248, protein: 46 },
  { name: 'Skyr natural', serving: '200 g', kcal: 118, protein: 22 },
  { name: 'Whey isolate', serving: '30 g', kcal: 112, protein: 27 },
  { name: 'Basmati rice cooked', serving: '200 g', kcal: 260, protein: 5 },
  { name: 'Olive oil', serving: '1 tbsp', kcal: 119, protein: 0 },
  { name: 'Banana', serving: '1 medium', kcal: 105, protein: 1 },
];

export type TimelineRow = {
  time: string;
  title: string;
  meta: string;
  state: 'done' | 'current' | 'future' | 'urgent';
  target: 'Habits' | 'School' | 'Notes' | 'Fuel' | 'Train';
};

export const timelineRows: TimelineRow[] = [
  { time: '06:45', title: 'Wake + 500 ml water', meta: 'Habit · logged', state: 'done', target: 'Habits' },
  { time: '07:10', title: 'Morning stack', meta: '2 of 5 habits ticked', state: 'future', target: 'Habits' },
  { time: '08:30', title: 'Statistics — lecture', meta: 'Room B2.14 · 90 min', state: 'future', target: 'School' },
  { time: '11:00', title: 'Deep work: thesis draft', meta: 'Work notes · two blocks', state: 'future', target: 'Notes' },
  { time: '12:40', title: 'Lunch', meta: '780 kcal · 62 g protein', state: 'done', target: 'Fuel' },
  { time: '15:00', title: 'Stats problem set 4', meta: 'Hand in before 15:00', state: 'urgent', target: 'School' },
  { time: '17:30', title: 'Push Day A', meta: 'Bench · OHP · Dips', state: 'current', target: 'Train' },
  { time: '20:00', title: 'Linear Algebra revision', meta: 'Exam in 12 days', state: 'future', target: 'School' },
  { time: '22:30', title: 'Phone down', meta: 'Habit · not negotiable', state: 'future', target: 'Habits' },
];

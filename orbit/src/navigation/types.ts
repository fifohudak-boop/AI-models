export type TodayStackParamList = {
  TodayHome: undefined;
  School: undefined;
};

export type HabitsStackParamList = {
  HabitsHome: undefined;
  HabitDetail: { habitId: string };
};

export type FuelStackParamList = {
  FuelHome: undefined;
  LogFood: undefined;
};

export type TrainStackParamList = {
  TrainHome: undefined;
  Session: { dayIndex: number };
  Strength: undefined;
  BodyWeight: undefined;
};

export type NotesStackParamList = {
  NotesHome: undefined;
  Folder: { folderId: string };
};

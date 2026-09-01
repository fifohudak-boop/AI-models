export const accentRamp = {
  200: '#E7E5FE',
  300: '#D2CEFD',
  400: '#B5ABFC',
  500: '#968AE0',
  600: '#796CBF',
  700: '#5D5294',
  800: '#423A6A',
  900: '#2B2741',
};

export const categoryColors = {
  blurple: '#9184D9',
  teal: '#7FB3A6',
  amber: '#D1A06B',
  rose: '#C98A9B',
  blue: '#7FA3D1',
  steel: '#9AA7B8',
};

export const palette = Object.values(categoryColors);

const darkNeutral = {
  200: '#E4E7F5',
  300: '#CFD3E5',
  400: '#B2B6CA',
  500: '#9397AB',
  600: '#75798C',
  700: '#595D6C',
  800: '#3F424D',
  900: '#292B31',
};

const lightNeutral = {
  200: '#3F424D',
  300: '#595D6C',
  400: '#595D6C',
  500: '#75798C',
  600: '#9397AB',
  700: '#CFD3E5',
  800: '#E4E7F5',
  900: '#F1F3FA',
};

export const darkTheme = {
  mode: 'dark' as const,
  bg: '#12131D',
  surface: '#232532',
  text: '#E9E9ED',
  neutral: darkNeutral,
  accent: '#9184D9',
  accentRamp,
  accentSoft: 'rgba(66,58,106,0.42)',
  tabBar: 'rgba(18,19,29,0.94)',
  danger: '#C98A9B',
};

export const lightTheme = {
  mode: 'light' as const,
  bg: '#F7F8FC',
  surface: '#FFFFFF',
  text: '#1B1D29',
  neutral: lightNeutral,
  accent: '#9184D9',
  accentRamp,
  accentSoft: '#EFEDFD',
  tabBar: 'rgba(255,255,255,0.94)',
  danger: '#C98A9B',
};

export type Theme = typeof darkTheme | typeof lightTheme;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const radii = {
  sm: 4,
  md: 8,
  lg: 14,
  sheet: 20,
  pill: 99,
};

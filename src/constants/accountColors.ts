export const ACCOUNT_COLOR_PRESETS = [
  "#E53E3E", // red
  "#DD6B20", // orange
  "#E8A020", // amber
  "#FCD34D", // bright yellow
  "#38A169", // green
  "#2563EB", // blue
  "#0EA5E9", // sky blue
  "#805AD5", // purple
  "#D53F8C", // pink
  "#319795", // teal
] as const;

export type AccountColorPreset = (typeof ACCOUNT_COLOR_PRESETS)[number];

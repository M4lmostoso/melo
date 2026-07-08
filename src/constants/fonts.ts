export type FontFamilyId =
  | "system"
  | "arial"
  | "calibri"
  | "times"
  | "courier"
  | "georgia"
  | "verdana"
  | "avenir"
  | "inter";

export const FONT_FAMILY_STACKS: Record<FontFamilyId, string> = {
  system: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  arial: "Arial, Helvetica, sans-serif",
  calibri: "Calibri, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  times: "Times New Roman, Times, serif",
  courier: "Courier New, Courier, monospace",
  georgia: "Georgia, Times, serif",
  verdana: "Verdana, Geneva, sans-serif",
  avenir: "Avenir, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  inter: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
};

// Icons an agent can wear instead of its initial, as 24x24 stroke paths.

export const AGENT_ICONS = {
  bug: "M9 7a3 3 0 0 1 6 0M7 10h10v5a5 5 0 0 1-10 0zM12 10v10M4 13h3M17 13h3",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18",
  shield: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  rocket: "M5 19c1-3 3-5 5-6M14 4c3 0 6 3 6 6l-7 7-6-6zM15 9h.01",
  pen: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3",
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  chat: "M5 5h14v10H9l-4 4z",
  wrench: "M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 1-2-2z",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  flag: "M5 21V4h11l-2 4 2 4H5",
  book: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6z",
} as const;

export type AgentIcon = keyof typeof AGENT_ICONS;
export const AGENT_ICON_NAMES = Object.keys(AGENT_ICONS) as AgentIcon[];

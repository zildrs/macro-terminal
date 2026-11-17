import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Obsidian design system (spec §4)
        base: "#09090b",
        panel: "#18181b",
        raised: "#1f1f23",
        line: "#27272a",
        "line-strong": "#3f3f46",
        ink: "#f4f4f5",
        "ink-2": "#a1a1aa",
        "ink-3": "#71717a",
        up: "#22c55e",
        down: "#ef4444",
        warn: "#f59e0b",
        // Categorical series colours (validated for CVD separation on the panel surface)
        s1: "#3987e5",
        s2: "#d95926",
        s3: "#199e70",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px" }],
        xs: ["11px", { lineHeight: "16px" }],
        sm: ["12px", { lineHeight: "18px" }],
      },
      keyframes: {
        tape: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "flash-up": {
          "0%": { backgroundColor: "rgba(34,197,94,0.28)" },
          "100%": { backgroundColor: "transparent" },
        },
        "flash-down": {
          "0%": { backgroundColor: "rgba(239,68,68,0.28)" },
          "100%": { backgroundColor: "transparent" },
        },
        pulse2: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        tape: "tape 60s linear infinite",
        "flash-up": "flash-up 0.9s ease-out",
        "flash-down": "flash-down 0.9s ease-out",
        pulse2: "pulse2 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;

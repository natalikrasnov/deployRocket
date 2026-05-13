/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/client/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      boxShadow: {
        glow: "0 0 38px rgba(34, 211, 238, 0.15), 0 0 18px rgba(168, 85, 247, 0.1)",
        "glow-cyan": "0 0 25px rgba(34, 211, 238, 0.2)",
        "glow-purple": "0 0 25px rgba(168, 85, 247, 0.2)"
      }
    }
  },
  plugins: []
};

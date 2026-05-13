/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/client/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      boxShadow: {
        glow: "0 0 38px rgba(251, 146, 60, 0.18), 0 0 18px rgba(34, 211, 238, 0.1)"
      }
    }
  },
  plugins: []
};

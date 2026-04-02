/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#06080f",
        surface: "#0e1225",
        surfaceHi: "#141938",
        border: "rgba(99,145,255,0.08)",
        accent: "#6391ff",
        dim: "#4b5580",
        success: "#00e5a0",
        warning: "#ffb020",
        danger: "#ff4d6a",
        purple: "#b18cff",
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

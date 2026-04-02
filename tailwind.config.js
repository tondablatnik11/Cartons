/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#0e1225",
        surfaceHi: "#141938",
        border: "rgba(99,145,255,0.08)",
        accent: "#6391ff",
        dim: "#4b5580",
      },
    },
  },
  plugins: [],
};

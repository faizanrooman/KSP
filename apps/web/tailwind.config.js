/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eef4ff', 100: '#dbe6fe', 200: '#bfd3fe', 300: '#93b4fd', 400: '#6090fa', 500: '#3b6cf6', 600: '#2550eb', 700: '#1d3ed8', 800: '#1e35af', 900: '#1e338a', 950: '#0f1b45' },
        ink: { 50: '#f7f8fa', 100: '#eef0f4', 200: '#dde1e8', 300: '#c2c8d3', 400: '#8f98a8', 500: '#687285', 600: '#4f586a', 700: '#3d4453', 800: '#262b36', 900: '#161a22', 950: '#0c0f14' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] },
    },
  },
  plugins: [],
};

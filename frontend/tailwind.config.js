/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          900: '#110f0d',
          800: '#1a1714',
          700: '#211e1a',
          600: '#2c2722',
          500: '#3d3530',
        },
        accent: {
          DEFAULT: '#f59e0b',
          hover: '#fbbf24',
          muted: '#4a3520',
        },
        surface: '#1e1b17',
        border: '#362f28',
        success: '#4ade80',
        danger: '#f87171',
        warning: '#fbbf24',
        info: '#60a5fa',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}

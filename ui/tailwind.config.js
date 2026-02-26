/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0a0a0b',
        panel: '#151517',
        accent: '#5a5ae6', // Mikup Purple
        textMuted: '#8b8b8f'
      }
    },
  },
  plugins: [],
}

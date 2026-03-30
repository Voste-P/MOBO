const rootConfig = require('../../tailwind.config.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [rootConfig],
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', '../../shared/**/*.{js,ts,jsx,tsx,mdx}'],
  plugins: [],
};

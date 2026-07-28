import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          bg:          'rgb(var(--app-bg)          / <alpha-value>)',
          surface:     'rgb(var(--app-surface)     / <alpha-value>)',
          card:        'rgb(var(--app-card)        / <alpha-value>)',
          cardHover:   'rgb(var(--app-cardHover)   / <alpha-value>)',
          border:      'rgb(var(--app-border)      / <alpha-value>)',
          borderLight: 'rgb(var(--app-borderLight) / <alpha-value>)',
        },
        primary: '#ffb000',
        'primary-container': '#ffc107',
        secondary: '#ff8f00',
        tertiary: '#b44a32',
        surface: '#f4f1e8',
        'surface-container-low': '#ebe7db',
        'surface-container-lowest': '#ffffff',
        'on-surface': '#1a1a1a',
        'on-surface-variant': '#5d5d5d',
        'outline-variant': 'rgba(0,0,0,0.05)',
        'inverse-surface': '#262626',
        brand: {
          blue: '#ffb000',
          blueLight: '#ffc107',
          violet: '#ff8f00',
          violetLight: '#ffb74d',
          cyan: '#d97706',
          cyanLight: '#f59e0b',
        },
        risk: {
          low: '#10b981',
          medium: '#f59e0b',
          high: '#f97316',
          critical: '#ef4444',
        },
        white: 'rgb(var(--color-white) / <alpha-value>)',
        gray: {
          100: 'rgb(var(--gray-100) / <alpha-value>)',
          200: 'rgb(var(--gray-200) / <alpha-value>)',
          300: 'rgb(var(--gray-300) / <alpha-value>)',
          400: 'rgb(var(--gray-400) / <alpha-value>)',
          500: 'rgb(var(--gray-500) / <alpha-value>)',
          600: 'rgb(var(--gray-600) / <alpha-value>)',
          700: 'rgb(var(--gray-700) / <alpha-value>)',
          800: 'rgb(var(--gray-800) / <alpha-value>)',
          900: 'rgb(var(--gray-900) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        '4xl': '32px',
      },
      transitionTimingFunction: {
        nexa: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-brand': 'linear-gradient(135deg, #ffb000 0%, #ff8f00 100%)',
        'gradient-danger': 'linear-gradient(135deg, #ef4444 0%, #f97316 100%)',
        'gradient-success': 'linear-gradient(135deg, #10b981 0%, #22d3ee 100%)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04)',
        'card-md': '0 8px 24px -4px rgba(15,23,42,0.08)',
        'card-lg': '0 12px 40px -12px rgba(15,23,42,0.15)',
        glow: '0 0 20px rgba(255,176,0,0.18)',
        'glow-danger': '0 0 20px rgba(239,68,68,0.15)',
        'glow-success': '0 0 20px rgba(16,185,129,0.15)',
        'glow-violet': '0 0 24px rgba(255,143,0,0.20)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        'float': 'float 7s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          // 'none' (não 'translateY(0)') no estado final: qualquer transform
          // diferente de 'none' cria um novo containing block, o que faz
          // position:fixed de modais descendentes (ex. WidgetEditorModal)
          // passar a se posicionar relativo a este container em vez da tela
          // inteira — sintoma: modal "aberto pela metade"/cortado.
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'none', opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      },
    },
  },
  plugins: [],
}

export default config

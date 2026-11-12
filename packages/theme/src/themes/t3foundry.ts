import { extendTheme } from '../contract.js';
import { warmAmberTheme } from './default.js';

/**
 * The default theme: T3Foundry brand identity.
 *
 * Royal blue accent on clean off-white backgrounds with soft blue-tinted
 * shadows. Blue carries the brand across every surface.
 */
export const defaultTheme = extendTheme(warmAmberTheme, {
  id: 'default',
  name: 'Default',
  description: 'Royal blue on clean off-white. The T3Foundry brand.',
  author: 'T3Foundry',

  light: {
    surface: {
      app: '#F8FAFD',
      sidebar: '#FFFFFF',
      panel: '#FFFFFF',
      raised: '#E8F2FF',
      sunken: '#F0F5FC',
      overlay: 'rgb(11 17 33 / 0.55)',
      selected: '#1F5EFF',
      highlight: '#E8F2FF',
    },
    content: {
      primary: '#1A1A1A',
      secondary: '#4B5563',
      muted: '#8A8FA3',
      inverted: '#FFFFFF',
      link: '#1F5EFF',
    },
    border: {
      subtle: '#E5E7EB',
      strong: '#D1D5DB',
      focus: '#00A3FF',
    },
    accent: {
      base: '#1F5EFF',
      hover: '#102A83',
      content: '#FFFFFF',
      subtle: '#E8F2FF',
    },
    status: {
      online: '#22A06B',
      away: '#E5A00D',
      busy: '#E5493A',
      offline: '#A8A29A',
      danger: '#D64545',
      warning: '#E5A00D',
      success: '#22A06B',
      info: '#00A3FF',
    },
    radius: {
      sm: '4px',
      md: '6px',
      lg: '10px',
      xl: '16px',
    },
    shadow: {
      sm: '0 1px 2px rgb(31 94 255 / 0.06)',
      md: '0 4px 12px rgb(31 94 255 / 0.08)',
      lg: '0 16px 40px rgb(16 42 131 / 0.15)',
    },
  },

  dark: {
    surface: {
      app: '#0B1121',
      sidebar: '#151F36',
      panel: '#151F36',
      raised: '#1D2638',
      sunken: '#0A0F1C',
      overlay: 'rgb(0 0 0 / 0.65)',
      selected: '#1F5EFF',
      highlight: '#1A2540',
    },
    content: {
      primary: '#FFFFFF',
      secondary: '#99A3B3',
      muted: '#667185',
      inverted: '#FFFFFF',
      link: '#00A3FF',
    },
    border: {
      subtle: '#1E2A45',
      strong: '#2D3A5C',
      focus: '#00A3FF',
    },
    accent: {
      base: '#1F5EFF',
      hover: '#3B7AFF',
      content: '#FFFFFF',
      subtle: '#1A2A50',
    },
    status: {
      online: '#3CC98A',
      away: '#F0B429',
      busy: '#F2695C',
      offline: '#6F675F',
      danger: '#F2695C',
      warning: '#F0B429',
      success: '#3CC98A',
      info: '#00A3FF',
    },
    radius: {
      sm: '4px',
      md: '6px',
      lg: '10px',
      xl: '16px',
    },
    shadow: {
      sm: '0 1px 2px rgb(0 0 0 / 0.4)',
      md: '0 4px 12px rgb(0 0 0 / 0.45)',
      lg: '0 16px 40px rgb(0 0 0 / 0.6)',
    },
  },
});

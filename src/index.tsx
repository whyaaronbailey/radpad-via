import '@webscopeio/react-textarea-autocomplete/style.css';
import {createRoot} from 'react-dom/client';
import {Router} from 'wouter';
import './app.global.css';
import Root from './containers/Root';
import {updateCSSVariables} from './utils/color-math';
import {
  getThemeModeFromStore,
  getThemeNameFromStore,
} from './utils/device-store';
import {THEMES} from './utils/themes';

import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .use(resourcesToBackend((lng: string) => import(`./locales/${lng}.json`)))
  .init({
    fallbackLng: 'en',
    debug: false,
    interpolation: {
      escapeValue: false,
    },
  });

const {MODE} = import.meta.env;

const elem = document.getElementById('root');
if (elem) {
  const root = createRoot(elem);
  // Hosted under a subfolder (GitHub Pages), so routes are relative to the build base.
  const {BASE_URL} = import.meta.env;
  const routerBase = BASE_URL.startsWith('/') ? BASE_URL.replace(/\/$/, '') : '';
  root.render(
    <Router base={routerBase}>
      <Root />
    </Router>,
  );
  document.documentElement.dataset['themeMode'] = getThemeModeFromStore();
  updateCSSVariables(getThemeNameFromStore() as keyof typeof THEMES);
}

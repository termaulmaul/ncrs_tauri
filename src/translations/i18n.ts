import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import id from './id.json';

export const defaultLng = 'id';
export const defaultNS = 'translations';
// this is exported in order to avoid hard coding supported languages in more than 1 place
export const resources = {
  id: {
    [defaultNS]: id,
  },
  en: {
    [defaultNS]: en,
  },
}

i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources,
		fallbackLng: defaultLng,
		debug: false,
		ns: [defaultNS],
		defaultNS: defaultNS,
		// by default ".". "if working with a flat JSON, it's recommended to set this to false"
		keySeparator: false,
		interpolation: {
			escapeValue: false
		}
	});

export default i18n;

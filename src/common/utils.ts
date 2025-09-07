import Cookies from 'js-cookie';
import localforage from 'localforage';
import { Dispatch, SetStateAction, useEffect, useLayoutEffect, useState } from 'react';
import packageJson from '../../package.json';
export { localforage };

export const VERSION = packageJson.version;

export const IS_DEVELOPMENT = import.meta.env.MODE === 'development';
export const IS_PRODUCTION = !IS_DEVELOPMENT;

export function useCookie(key: string, defaultValue: string, options: Cookies.CookieAttributes = { expires: 365000, sameSite: 'lax', path: '/' }): [string, Dispatch<SetStateAction<string>>] {
	// cookie expires in a millenia
	// sameSite != 'strict' because the cookie is not read for sensitive actions
	// synchronous
	const cookieValue = Cookies.get(key);
	const [state, setState] = useState(cookieValue || defaultValue);
	useEffect(() => {
		Cookies.set(key, state, options);
	}, [state]);
	return [state, setState];
}

export function trueTypeOf(obj: any) {
	return Object.prototype.toString.call(obj).slice(8, -1).toLowerCase()
	/*
			[]              -> array
			{}              -> object
			''              -> string
			new Date()      -> date
			1               -> number
			function () {}  -> function
			async function () {}  -> asyncfunction
			/test/i         -> regexp
			true            -> boolean
			null            -> null
			trueTypeOf()    -> undefined
	*/
}

// https://reactjs.org/docs/hooks-custom.html
export function useLocalForage<T>(key: string, defaultValue: T): [T, Dispatch<SetStateAction<T>>, boolean] {
	// only supports primitives, arrays, and {} objects
	const [state, setState] = useState(defaultValue);
	const [loading, setLoading] = useState(true);

	// useLayoutEffect will be called before DOM paintings and before useEffect
	useLayoutEffect(() => {
		let allow = true;
		localforage.getItem(key)
			.then(value => {
				if (value === null) throw '';
				if (allow) setState(value as T);
			}).catch(() => localforage.setItem(key, defaultValue))
			.then(() => {
				if (allow) setLoading(false);
			});
		return () => { allow = false; }
	}, []);
	// useLayoutEffect does not like Promise return values.
	useEffect(() => {
		// do not allow setState to be called before data has even been loaded!
		// this prevents overwriting
		if (!loading) localforage.setItem(key, state);
	}, [state]);
	return [state, setState, loading];
}

// show browser / native notification
export function notify(title: string, body: string) {
	new Notification(title, { body: body || "", });
}

export function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function downloadFile(filename: string, content: BlobPart, contentType = 'text/plain') {
  const element = document.createElement('a');
  const file = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(file);
  element.href = url;
  element.download = filename;
  document.body.appendChild(element); // Required for this to work in some browsers
  element.click();
  // Cleanup to avoid memory leaks and improve Safari compatibility
  setTimeout(() => {
    document.body.removeChild(element);
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * Sanitize a filename by removing illegal characters and trimming spaces.
 * Also collapses consecutive spaces/underscores and trims dots at ends.
 */
export function sanitizeFilename(name: string) {
  if (!name) return 'document';
  // Remove illegal characters for Windows/macOS/Linux
  const illegal = /[\\/:*?"<>|]/g;
  let out = name.replace(illegal, ' ').replace(/\s+/g, ' ').trim();
  // Replace remaining spaces with underscores for portability
  out = out.replace(/\s+/g, '_');
  // Avoid names like '.' or '..'
  out = out.replace(/^\.+|\.+$/g, '');
  return out || 'document';
}


export function arraysEqual<T>(a: T[], b: T[]) {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (a.length !== b.length) return false;

	// If you don't care about the order of the elements inside
	// the array, you should sort both arrays here.
	// Please note that calling sort on an array will modify that array.
	// you might want to clone your array first.

	for (var i = 0; i < a.length; ++i) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Joins path segments with a specified separator
 * @param separator The separator to use between segments (e.g., '/', '\', '.')
 * @param segments The path segments to join
 * @returns The joined path string
 */
export function join(separator: string, ...segments: string[]): string | null {
	if (!segments || segments.length === 0) return '';
	if (segments.find(x => !(typeof x === 'string'))) return null;
	return segments.join(separator);
}

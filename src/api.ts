// Calls our API (api/ folder) with the logged-in user's Firebase token.
// The API checks the token, so it knows who is calling without trusting anything else we send.

import { auth } from './firebase';

// Set in .env, e.g. http://localhost:3000. EXPO_PUBLIC_ values are built into the app, so never put a secret here.
// A trailing slash is removed, so "https://x.app/" + "/me" doesn't become "https://x.app//me" (a 404).
const API_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');

// Give up after 10 s, so a hanging API can't leave the app stuck on "loading".
const TIMEOUT_MS = 10_000;

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');
  if (!API_URL) throw new Error('EXPO_PUBLIC_API_URL is not set');

  // getIdToken() returns the saved token, or a fresh one if it is about to expire (tokens last 1 hour).
  const token = await user.getIdToken();

  // AbortController + setTimeout instead of AbortSignal.timeout(): that newer API is missing from some
  // JavaScript engines (React Native's Hermes on older versions), where it would make every call throw.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`API ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

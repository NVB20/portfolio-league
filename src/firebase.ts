// Connects the app to our Firebase project ONE time.
// We use Firebase only for login (Auth). App data lives in Postgres, behind our API (see src/api.ts).

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// Expo copies every variable that starts with EXPO_PUBLIC_ from .env into the app.
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID
};

// Create the connection to our Firebase project.
const app = initializeApp(firebaseConfig);

// The login screen imports it:  import { auth } from './firebase';
export const auth = getAuth(app);

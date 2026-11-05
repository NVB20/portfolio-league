// URL "/" (the home address). For now it just sends you to /login.
// Later: logged in -> /dashboard, logged out -> /login.

import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/login" />;
}

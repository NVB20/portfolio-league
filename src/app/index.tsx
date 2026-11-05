// URL "/" (the home address). Only logged-in users reach it (see _layout.tsx),
// so it just sends them to their dashboard.

import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/dashboard" />;
}

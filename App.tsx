import { StatusBar } from 'expo-status-bar';
import LoginScreen from './src/screens/LoginScreen';

// For now the app is just the login screen.
// Later this decides: logged in -> homepage, logged out -> login.
export default function App() {
  return (
    <>
      <LoginScreen />
      <StatusBar style="auto" />
    </>
  );
}

// Turns Firebase's error codes (English, technical) into Hebrew messages for the user.
// Firebase errors have a `code` like 'auth/invalid-credential'.

const messages: Record<string, string> = {
  // Wrong email OR wrong password. Firebase doesn't say which one on purpose,
  // so attackers can't find out which emails have accounts.
  'auth/invalid-credential': 'אימייל או סיסמה שגויים',
  'auth/invalid-email': 'כתובת האימייל לא תקינה',
  'auth/missing-password': 'יש להזין סיסמה',
  'auth/email-already-in-use': 'האימייל כבר רשום. נסו להתחבר',
  'auth/weak-password': 'הסיסמה קצרה מדי (לפחות 6 תווים)',
  'auth/too-many-requests': 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות',
  'auth/network-request-failed': 'אין חיבור לאינטרנט',
};

export function authErrorMessage(error: unknown): string {
  // `unknown` = we don't know what was thrown, so we check before reading `.code`.
  const code = (error as { code?: string })?.code ?? '';
  return messages[code] ?? 'משהו השתבש. נסו שוב';
}

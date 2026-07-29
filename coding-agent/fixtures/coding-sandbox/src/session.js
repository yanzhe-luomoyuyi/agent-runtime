/**
 * Toy session helper — intentional bug: getUserName crashes when session is null.
 */

export function getUserName(session) {
  // BUG: missing null/undefined guard — should return 'anonymous'
  return session.user.name;
}

export function createSession(user) {
  return { user };
}

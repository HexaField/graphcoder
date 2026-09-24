export function validate(user: string, password: string): boolean {
  return user.length > 0 && password.length >= 8
}

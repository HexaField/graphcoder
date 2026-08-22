/**
 * Adds two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b
}

/**
 * Multiplies two numbers together.
 */
export function multiply(a: number, b: number): number {
  return a * b
}

/**
 * Computes the power of a number.
 */
export function power(base: number, exp: number): number {
  return multiply(base, exp > 1 ? power(base, exp - 1) : 1)
}

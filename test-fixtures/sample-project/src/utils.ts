import { add, multiply } from './math.js'

/**
 * Formats a number result with a label.
 */
export function formatResult(label: string, value: number): string {
  return `${label}: ${value}`
}

/**
 * Computes the area of a rectangle and formats it.
 */
export function rectangleArea(width: number, height: number): string {
  const area = multiply(width, height)
  return formatResult('Area', area)
}

/**
 * Computes the perimeter of a rectangle and formats it.
 */
export function rectanglePerimeter(width: number, height: number): string {
  const perimeter = add(add(width, height), add(width, height))
  return formatResult('Perimeter', perimeter)
}

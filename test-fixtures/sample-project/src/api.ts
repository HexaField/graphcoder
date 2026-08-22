import { rectangleArea, rectanglePerimeter } from './utils.js'

export interface ShapeInput {
  width: number
  height: number
}

export interface ShapeResult {
  area: string
  perimeter: string
}

/**
 * Processes a shape and returns its measurements.
 */
export function processShape(input: ShapeInput): ShapeResult {
  return {
    area: rectangleArea(input.width, input.height),
    perimeter: rectanglePerimeter(input.width, input.height)
  }
}

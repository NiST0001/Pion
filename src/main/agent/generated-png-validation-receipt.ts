import { Buffer } from 'node:buffer'
import {
  assertGeneratedPngData, GENERATED_PNG_VALIDATION_LIMITS,
  type GeneratedPngValidationLimits
} from './png-validation'

type Dimensions = { width: number; height: number }

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/** Native slots bypass caller-defined getters, iterators and Buffer.slice views.
 * All validation, subsequent awaits and publication use the independent copy. */
export function snapshotGeneratedPngBytes(value: Uint8Array): Uint8Array {
  if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) throw new Error('Invalid generated PNG bytes')
  const prototype = Object.getPrototypeOf(Uint8Array.prototype)
  const view = new Uint8Array(Reflect.get(prototype, 'buffer', value),
    Reflect.get(prototype, 'byteOffset', value), Reflect.get(prototype, 'byteLength', value))
  if (view.byteLength < 57 || view.byteLength > GENERATED_PNG_VALIDATION_LIMITS.maxBytes) throw new Error('Invalid generated PNG byte size')
  return new Uint8Array(view)
}

/** One execution, at most one private snapshot, one consume attempt. Only a
 * complete fixed-policy validation can issue a receipt. No tag/hash is trusted.
 * Disposal also prevents a late operation from retaining a new snapshot. */
export function createGeneratedPngValidationReceipt() {
  interface Receipt { snapshot: Buffer; width: number; height: number; limits: GeneratedPngValidationLimits }
  let receipts = new WeakMap<Uint8Array, Receipt>()
  let issued = false
  let closed = false
  return {
    validate(bytes: Uint8Array, dimensions: Dimensions): void {
      receipts = new WeakMap()
      const canIssue = !closed && !issued
      issued = true
      const snapshot = snapshotGeneratedPngBytes(bytes)
      const width = ownDataValue(dimensions, 'width')
      const height = ownDataValue(dimensions, 'height')
      if (typeof width !== 'number' || typeof height !== 'number') throw new Error('Invalid generated PNG dimensions')
      assertGeneratedPngData(snapshot, { width, height })
      if (canIssue && !closed) {
        receipts.set(bytes, { snapshot: Buffer.from(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength),
          width, height, limits: GENERATED_PNG_VALIDATION_LIMITS })
      }
    },
    consume(source: Uint8Array, snapshot: Uint8Array, dimensions: Dimensions,
      limits: GeneratedPngValidationLimits = GENERATED_PNG_VALIDATION_LIMITS): boolean {
      const receipt = receipts.get(source)
      closed = true
      receipts = new WeakMap()
      return !!receipt && receipt.width === ownDataValue(dimensions, 'width') && receipt.height === ownDataValue(dimensions, 'height')
        && (Object.keys(receipt.limits) as (keyof GeneratedPngValidationLimits)[]).every((key) => receipt.limits[key] === ownDataValue(limits, key))
        && receipt.snapshot.equals(snapshot)
    },
    dispose(): void { closed = true; receipts = new WeakMap() }
  }
}

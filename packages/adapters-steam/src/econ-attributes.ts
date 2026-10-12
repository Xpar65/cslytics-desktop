import type { EconAttributeKind } from '@cslytics/ports';
import { ECON_ATTRIBUTES } from './econ-attributes.generated.js';

/**
 * One econ attribute's value, decoded the way Valve's schema says it is stored.
 *
 * The Game Coordinator sends every attribute as `value_bytes` and leaves `value` null (measured
 * 2026-09-13; `cslytics-app-docs/steam/gc-inventory.md`). What those bytes
 * mean is only known from `items_game.txt`: attribute 8 is a float, 75 a uint32 of unix seconds,
 * 6 a float that must be floored, 111 a UTF-8 string after a two-byte prefix. The adapter is the
 * one place that knows the schema; the engine stores what comes out and reads by number.
 *
 * An attribute the table does not name decodes to nothing, and the raw bytes travel on for the
 * engine to keep as hex. A later table regeneration then re-derives it without a new walk.
 */
export function decodeEconAttribute(defIndex: number, bytes: Uint8Array | undefined): { kind: EconAttributeKind; value: number | string } | undefined {
  const definition = ECON_ATTRIBUTES.get(defIndex);
  if (!definition || !bytes) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (definition.kind) {
    case 'uint32':
      return bytes.byteLength >= 4 ? { kind: 'uint32', value: view.getUint32(0, true) } : undefined;
    case 'float':
      return bytes.byteLength >= 4 ? { kind: 'float', value: view.getFloat32(0, true) } : undefined;
    case 'floored-float':
      return bytes.byteLength >= 4 ? { kind: 'floored-float', value: Math.floor(view.getFloat32(0, true)) } : undefined;
    case 'string':
      // `globaloffensive` skips two bytes of prefix before the UTF-8; a shorter payload is an
      // empty name.
      return { kind: 'string', value: bytes.byteLength > 2 ? new TextDecoder().decode(bytes.subarray(2)) : '' };
    case 'vector':
      return bytes.byteLength >= 12
        ? { kind: 'vector', value: `${view.getFloat32(0, true)},${view.getFloat32(4, true)},${view.getFloat32(8, true)}` }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Open Location Code (Plus Code) decoding — pure, no platform imports.
 *
 * Delivery locations on the wire are Plus Codes (GLOSSARY.md); routing needs
 * coordinates, so checkout decodes them here. Pair-level decode only (up to
 * 10 digits, ≈14 m cells); grid-refinement digits beyond 10 are ignored —
 * finer than routing ever needs. Short codes ("6FR5+8X Lagos") are recovered
 * against a reference location (the market center) per the OLC spec.
 */

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;
const PAIR_CODE_LENGTH = 10;
/** Place value of each pair, most significant first (degrees). */
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];

export interface PlusCodeLocation {
  /** Cell center. */
  latitude: number;
  longitude: number;
  /** Cell size in degrees — the decode's uncertainty. */
  resolutionDegrees: number;
}

const clipLatitude = (latitude: number): number => Math.min(90, Math.max(-90, latitude));

const normalizeLongitude = (longitude: number): number => {
  let value = longitude;
  while (value < -180) value += 360;
  while (value >= 180) value -= 360;
  return value;
};

/**
 * Strip a code down to its digits: drop the locality (" Lagos"), uppercase,
 * remove the separator and padding. Returns null when the shape is invalid.
 */
function normalizeDigits(raw: string): { digits: string; separatorIndex: number } | null {
  const token = raw.trim().toUpperCase().split(/\s+/)[0] ?? "";
  const separatorIndex = token.indexOf(SEPARATOR);
  if (separatorIndex === -1 || separatorIndex !== token.lastIndexOf(SEPARATOR)) return null;
  if (separatorIndex > SEPARATOR_POSITION || separatorIndex % 2 === 1) return null;
  const head = token.slice(0, separatorIndex).replace(/0+$/, "");
  const tail = token.slice(separatorIndex + 1);
  const digits = head + tail;
  if (digits.length < 2) return null;
  for (const ch of digits) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return { digits, separatorIndex };
}

/** Decode a full code's digits (≤10 pair digits) into a cell. */
function decodeDigits(digits: string): PlusCodeLocation {
  let latitude = -90;
  let longitude = -180;
  const pairs = Math.min(Math.floor(digits.length / 2), PAIR_CODE_LENGTH / 2);
  for (let i = 0; i < pairs; i += 1) {
    latitude += ALPHABET.indexOf(digits[2 * i]!) * PAIR_RESOLUTIONS[i]!;
    longitude += ALPHABET.indexOf(digits[2 * i + 1]!) * PAIR_RESOLUTIONS[i]!;
  }
  const resolution = PAIR_RESOLUTIONS[Math.max(0, pairs - 1)]!;
  return {
    latitude: Math.min(90, latitude + resolution / 2),
    longitude: Math.min(180, longitude + resolution / 2),
    resolutionDegrees: resolution,
  };
}

/** Pair-level encode (10 digits) — used to prefix short codes at recovery. */
function encodePairPrefix(latitude: number, longitude: number, digitCount: number): string {
  let lat = Math.min(clipLatitude(latitude), 90 - PAIR_RESOLUTIONS[4]!) + 90;
  let lng = normalizeLongitude(longitude) + 180;
  let code = "";
  for (let i = 0; i < PAIR_CODE_LENGTH / 2; i += 1) {
    const resolution = PAIR_RESOLUTIONS[i]!;
    const latDigit = Math.min(19, Math.floor(lat / resolution));
    const lngDigit = Math.min(19, Math.floor(lng / resolution));
    lat -= latDigit * resolution;
    lng -= lngDigit * resolution;
    code += ALPHABET[latDigit]! + ALPHABET[lngDigit]!;
  }
  return code.slice(0, digitCount);
}

/**
 * Resolve a Plus Code to coordinates. Full codes decode directly; short codes
 * recover against `reference` (typically the market center). Returns null for
 * anything that is not a usable code — callers fall back, never crash.
 */
export function plusCodeToLocation(
  raw: string,
  reference?: { latitude: number; longitude: number },
): PlusCodeLocation | null {
  const normalized = normalizeDigits(raw);
  if (!normalized) return null;
  const { digits, separatorIndex } = normalized;

  if (separatorIndex >= SEPARATOR_POSITION) {
    // Full code.
    return decodeDigits(digits.slice(0, PAIR_CODE_LENGTH));
  }

  // Short code: recover the omitted leading digits from the reference.
  if (!reference) return null;
  const paddingLength = SEPARATOR_POSITION - separatorIndex;
  const resolution = Math.pow(20, 2 - paddingLength / 2);
  const halfResolution = resolution / 2;
  const prefix = encodePairPrefix(reference.latitude, reference.longitude, paddingLength);
  const area = decodeDigits((prefix + digits).slice(0, PAIR_CODE_LENGTH));

  // Shift by whole cells until the area is the nearest match to the reference.
  let { latitude, longitude } = area;
  const refLat = clipLatitude(reference.latitude);
  const refLng = normalizeLongitude(reference.longitude);
  if (refLat + halfResolution < latitude && latitude - resolution >= -90) latitude -= resolution;
  else if (refLat - halfResolution > latitude && latitude + resolution <= 90) latitude += resolution;
  if (refLng + halfResolution < longitude) longitude -= resolution;
  else if (refLng - halfResolution > longitude) longitude += resolution;

  return { latitude, longitude, resolutionDegrees: area.resolutionDegrees };
}

/** Internal Runner Floor Rate. Tune these integer-kobo coefficients per Market. */
export interface FloorRateInputs {
  distanceMeters: number;
  estimatedDurationMs: number;
  baseKobo: number;
  perKilometerKobo: number;
  perMinuteKobo: number;
}

export function floorRate(input: FloorRateInputs): number {
  const values = Object.values(input);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Floor Rate inputs must be non-negative finite values");
  }
  return Math.ceil(
    input.baseKobo +
      (input.distanceMeters / 1_000) * input.perKilometerKobo +
      (input.estimatedDurationMs / 60_000) * input.perMinuteKobo,
  );
}
